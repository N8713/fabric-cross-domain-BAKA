'use strict';

const grpc = require('@grpc/grpc-js');
const { connect, hash, signers } = require('@hyperledger/fabric-gateway');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const channelName = 'mychannel';
const chaincodeName = 'iotcc';

const testNetworkPath = path.resolve(__dirname, '../test-network');
const resultsPath = path.resolve(__dirname, 'revocation_delay_results.csv');

const loadLevels = [0, 8, 16];

const backgroundBatchSize = 200;


const pollIntervalMs = 20;

const observeTimeoutMs = 15000;


const backgroundQuerySleepMs = 0;

function orgConfig(org) {
    if (org === 1) {
        return {
            mspId: 'Org1MSP',
            peerEndpoint: 'localhost:7051',
            peerHostAlias: 'peer0.org1.example.com',
            tlsCertPath: path.resolve(testNetworkPath, 'organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt'),
            certDirectoryPath: path.resolve(testNetworkPath, 'organizations/peerOrganizations/org1.example.com/users/User1@org1.example.com/msp/signcerts'),
            keyDirectoryPath: path.resolve(testNetworkPath, 'organizations/peerOrganizations/org1.example.com/users/User1@org1.example.com/msp/keystore')
        };
    }

    return {
        mspId: 'Org2MSP',
        peerEndpoint: 'localhost:9051',
        peerHostAlias: 'peer0.org2.example.com',
        tlsCertPath: path.resolve(testNetworkPath, 'organizations/peerOrganizations/org2.example.com/peers/peer0.org2.example.com/tls/ca.crt'),
        certDirectoryPath: path.resolve(testNetworkPath, 'organizations/peerOrganizations/org2.example.com/users/User1@org2.example.com/msp/signcerts'),
        keyDirectoryPath: path.resolve(testNetworkPath, 'organizations/peerOrganizations/org2.example.com/users/User1@org2.example.com/msp/keystore')
    };
}

async function newGrpcConnection(config) {
    const tlsRootCert = await fs.readFile(config.tlsCertPath);
    const tlsCredentials = grpc.credentials.createSsl(tlsRootCert);

    return new grpc.Client(config.peerEndpoint, tlsCredentials, {
        'grpc.ssl_target_name_override': config.peerHostAlias
    });
}

async function newIdentity(config) {
    const files = await fs.readdir(config.certDirectoryPath);
    if (files.length === 0) {
        throw new Error(`No certificate found in ${config.certDirectoryPath}`);
    }

    const certPath = path.join(config.certDirectoryPath, files[0]);
    const credentials = await fs.readFile(certPath);

    return {
        mspId: config.mspId,
        credentials
    };
}

async function newSigner(config) {
    const files = await fs.readdir(config.keyDirectoryPath);
    if (files.length === 0) {
        throw new Error(`No private key found in ${config.keyDirectoryPath}`);
    }

    const keyPath = path.join(config.keyDirectoryPath, files[0]);
    const privateKeyPem = await fs.readFile(keyPath);
    const privateKey = crypto.createPrivateKey(privateKeyPem);

    return signers.newPrivateKeySigner(privateKey);
}

async function getContract(org) {
    const config = orgConfig(org);
    const client = await newGrpcConnection(config);

    const gateway = connect({
        client,
        identity: await newIdentity(config),
        signer: await newSigner(config),
        hash: hash.sha256,
        evaluateOptions: () => {
            return { deadline: Date.now() + 30000 };
        },
        endorseOptions: () => {
            return { deadline: Date.now() + 30000 };
        },
        submitOptions: () => {
            return { deadline: Date.now() + 30000 };
        },
        commitStatusOptions: () => {
            return { deadline: Date.now() + 60000 };
        }
    });

    const network = gateway.getNetwork(channelName);
    const contract = network.getContract(chaincodeName);

    return {
        gateway,
        client,
        contract
    };
}

function randomHex(bytes = 32) {
    return crypto.randomBytes(bytes).toString('hex');
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function nowMs() {
    const [sec, nano] = process.hrtime();
    return sec * 1000 + nano / 1e6;
}

async function timeMs(fn) {
    const start = nowMs();
    const result = await fn();
    const end = nowMs();

    return {
        ms: end - start,
        result
    };
}

function calcStats(values) {
    if (values.length === 0) {
        return {
            count: 0,
            total: 0,
            avg: 0,
            median: 0,
            p95: 0,
            min: 0,
            max: 0
        };
    }

    const sorted = [...values].sort((a, b) => a - b);
    const count = sorted.length;
    const total = sorted.reduce((a, b) => a + b, 0);
    const avg = total / count;
    const median = sorted[Math.floor(count / 2)];
    const p95 = sorted[Math.min(count - 1, Math.ceil(count * 0.95) - 1)];

    return {
        count,
        total,
        avg,
        median,
        p95,
        min: sorted[0],
        max: sorted[count - 1]
    };
}

function resultToString(result) {
    if (result === undefined || result === null) {
        return '';
    }

    if (Buffer.isBuffer(result) || result instanceof Uint8Array) {
        return Buffer.from(result).toString('utf8');
    }

    return String(result);
}

/**
 * 尽量兼容不同链码返回格式。
 *
 * 常见可能形式：
 *   {"pid":"xxx","status":"revoked"}
 *   {"pid":"xxx","revoked":true}
 *   {"pid":"xxx","valid":false}
 *   {"pid":"xxx","active":false}
 *
 * 如果你的链码返回格式不同，后面根据第一次输出的 raw query result 再微调这里。
 */
function isRevokedResult(rawText) {
    const text = rawText.toLowerCase();

    if (text.includes('revoked')) return true;
    if (text.includes('"status":"invalid"')) return true;
    if (text.includes('"state":"invalid"')) return true;
    if (text.includes('"valid":false')) return true;
    if (text.includes('"active":false')) return true;
    if (text.includes('"isrevoked":true')) return true;
    if (text.includes('"revoked":true')) return true;

    return false;
}

function isNotFoundError(error) {
    const msg = String(error.message || error).toLowerCase();

    return (
        msg.includes('not found') ||
        msg.includes('does not exist') ||
        msg.includes('not exist') ||
        msg.includes('not_found')
    );
}

async function appendCsv(row) {
    const header = [
        'run_tag',
        'load_concurrency',
        'round',
        'pid',
        'register_ms',
        'pre_query_ms',
        'revoke_commit_ms',
        'first_query_after_commit_ms',
        'post_commit_visibility_ms',
        'enforcement_gap_ms',
        'poll_count',
        'observed_revoked',
        'observe_mode',
        'background_success',
        'background_failed'
    ].join(',') + '\n';

    try {
        await fs.access(resultsPath);
    } catch {
        await fs.writeFile(resultsPath, header);
    }

    const line = [
        row.runTag,
        row.loadConcurrency,
        row.round,
        row.pid,
        row.registerMs.toFixed(3),
        row.preQueryMs.toFixed(3),
        row.revokeCommitMs.toFixed(3),
        row.firstQueryAfterCommitMs.toFixed(3),
        row.postCommitVisibilityMs.toFixed(3),
        row.enforcementGapMs.toFixed(3),
        row.pollCount,
        row.observedRevoked,
        row.observeMode,
        row.backgroundSuccess,
        row.backgroundFailed
    ].join(',') + '\n';

    await fs.appendFile(resultsPath, line);
}

async function warmup(org1Contract, org2Contract) {
    const pid = `WARMUP_REVOKE_${Date.now()}`;

    try {
        await org1Contract.submitTransaction(
            'RegisterDevice',
            pid,
            randomHex(),
            randomHex(),
            'DomainA'
        );

        await org2Contract.evaluateTransaction('QueryDevice', pid);

        await org1Contract.submitTransaction('RevokeDevice', pid);

        await org2Contract.evaluateTransaction('QueryDevice', pid);
    } catch (error) {
        console.log(`Warmup warning: ${error.message}`);
    }
}

function buildBackgroundDeviceIds(runTag) {
    const pids = [];

    for (let i = 0; i < backgroundBatchSize; i++) {
        pids.push(`SD_A_REVOKE_BG_${runTag}_${i}`);
    }

    return pids;
}

async function prepareBackgroundDevices(org1Contract, pids) {
    console.log(`\nPreparing ${pids.length} background devices for QueryDevices load...`);

    for (let i = 0; i < pids.length; i++) {
        const pid = pids[i];

        await org1Contract.submitTransaction(
            'RegisterDevice',
            pid,
            randomHex(),
            randomHex(),
            'DomainA'
        );

        if ((i + 1) % 20 === 0 || i + 1 === pids.length) {
            console.log(`  Registered background devices ${i + 1}/${pids.length}`);
        }
    }

    console.log('Background device preparation completed.');
}

async function createQueryClients(concurrency) {
    const clients = [];

    for (let i = 0; i < concurrency; i++) {
        clients.push(await getContract(2));
    }

    return clients;
}

function closeClients(clients) {
    for (const c of clients) {
        try {
            c.gateway.close();
        } catch {}

        try {
            c.client.close();
        } catch {}
    }
}

async function startBackgroundQueryLoad(concurrency, pids) {
    if (concurrency <= 0) {
        return {
            stop: async () => {},
            stats: {
                success: 0,
                failed: 0
            }
        };
    }

    console.log(`\nStarting background QueryDevices load: concurrency=${concurrency}, batchSize=${pids.length}`);

    const clients = await createQueryClients(concurrency);
    const stopSignal = {
        stopped: false
    };

    const stats = {
        success: 0,
        failed: 0
    };

    const tasks = clients.map((clientObj, index) => {
        return (async () => {
            while (!stopSignal.stopped) {
                try {
                    await clientObj.contract.evaluateTransaction(
                        'QueryDevices',
                        JSON.stringify(pids)
                    );
                    stats.success++;
                } catch (error) {
                    stats.failed++;
                    console.error(`Background query worker ${index} failed: ${error.message}`);
                }

                if (backgroundQuerySleepMs > 0) {
                    await sleep(backgroundQuerySleepMs);
                }
            }
        })();
    });

    await sleep(1000);

    return {
        stats,
        stop: async () => {
            stopSignal.stopped = true;
            await Promise.allSettled(tasks);
            closeClients(clients);
            console.log(
                `Background load stopped: success=${stats.success}, failed=${stats.failed}`
            );
        }
    };
}

async function pollUntilRevoked(org2Contract, pid, revokeStartMs, revokeCommitEndMs) {
    const observeStart = nowMs();
    let pollCount = 0;
    let firstQueryAfterCommitMs = 0;

    while (nowMs() - observeStart <= observeTimeoutMs) {
        pollCount++;

        const queryStart = nowMs();

        try {
            const result = await org2Contract.evaluateTransaction('QueryDevice', pid);
            const queryEnd = nowMs();
            const queryLatency = queryEnd - queryStart;

            if (pollCount === 1) {
                firstQueryAfterCommitMs = queryLatency;
            }

            const rawText = resultToString(result);

            if (isRevokedResult(rawText)) {
                return {
                    observedRevoked: true,
                    observeMode: 'QUERY_REVOKED',
                    firstQueryAfterCommitMs,
                    postCommitVisibilityMs: queryEnd - revokeCommitEndMs,
                    enforcementGapMs: queryEnd - revokeStartMs,
                    pollCount,
                    rawText
                };
            }
        } catch (error) {
            const queryEnd = nowMs();
            const queryLatency = queryEnd - queryStart;

            if (pollCount === 1) {
                firstQueryAfterCommitMs = queryLatency;
            }

            // 如果撤销后 QueryDevice 变成 not found，也可以视为该设备不能继续被有效查询/认证。
            if (isNotFoundError(error)) {
                return {
                    observedRevoked: true,
                    observeMode: 'QUERY_NOT_FOUND_AFTER_REVOKE',
                    firstQueryAfterCommitMs,
                    postCommitVisibilityMs: queryEnd - revokeCommitEndMs,
                    enforcementGapMs: queryEnd - revokeStartMs,
                    pollCount,
                    rawText: error.message
                };
            }
        }

        await sleep(pollIntervalMs);
    }

    return {
        observedRevoked: false,
        observeMode: 'TIMEOUT',
        firstQueryAfterCommitMs,
        postCommitVisibilityMs: nowMs() - revokeCommitEndMs,
        enforcementGapMs: nowMs() - revokeStartMs,
        pollCount,
        rawText: ''
    };
}

async function runOneRevocationRound(runTag, round, loadConcurrency, org1Contract, org2Contract, backgroundStats) {
    const pid = `SD_A_REVOKE_${runTag}_L${loadConcurrency}_R${round}`;

    const registerTime = await timeMs(() =>
        org1Contract.submitTransaction(
            'RegisterDevice',
            pid,
            randomHex(),
            randomHex(),
            'DomainA'
        )
    );

    const preQueryTime = await timeMs(() =>
        org2Contract.evaluateTransaction('QueryDevice', pid)
    );

    const revokeStartMs = nowMs();

    const revokeTime = await timeMs(() =>
        org1Contract.submitTransaction('RevokeDevice', pid)
    );

    const revokeCommitEndMs = nowMs();

    const observe = await pollUntilRevoked(
        org2Contract,
        pid,
        revokeStartMs,
        revokeCommitEndMs
    );

    if (round === 1) {
        console.log(`  First observed query result after revocation, load=${loadConcurrency}:`);
        console.log(`  ${observe.rawText.substring(0, 300)}`);
    }

    const row = {
        runTag,
        loadConcurrency,
        round,
        pid,
        registerMs: registerTime.ms,
        preQueryMs: preQueryTime.ms,
        revokeCommitMs: revokeTime.ms,
        firstQueryAfterCommitMs: observe.firstQueryAfterCommitMs,
        postCommitVisibilityMs: observe.postCommitVisibilityMs,
        enforcementGapMs: observe.enforcementGapMs,
        pollCount: observe.pollCount,
        observedRevoked: observe.observedRevoked,
        observeMode: observe.observeMode,
        backgroundSuccess: backgroundStats.success,
        backgroundFailed: backgroundStats.failed
    };

    await appendCsv(row);

    console.log(
        `Round ${round}, load=${loadConcurrency}: ` +
        `register=${row.registerMs.toFixed(3)} ms, ` +
        `revokeCommit=${row.revokeCommitMs.toFixed(3)} ms, ` +
        `postCommitVisibility=${row.postCommitVisibilityMs.toFixed(3)} ms, ` +
        `enforcementGap=${row.enforcementGapMs.toFixed(3)} ms, ` +
        `polls=${row.pollCount}, observed=${row.observedRevoked}, mode=${row.observeMode}`
    );

    return row;
}

async function runLoadScenario(runTag, loadConcurrency, rounds, org1Contract, org2Contract, backgroundPids) {
    console.log(`\n========== Revocation enforcement test: load=${loadConcurrency}, rounds=${rounds} ==========`);

    const background = await startBackgroundQueryLoad(loadConcurrency, backgroundPids);

    const rows = [];

    try {
        for (let r = 1; r <= rounds; r++) {
            const row = await runOneRevocationRound(
                runTag,
                r,
                loadConcurrency,
                org1Contract,
                org2Contract,
                background.stats
            );

            rows.push(row);

            await sleep(300);
        }
    } finally {
        await background.stop();
    }

    const commitStats = calcStats(rows.map(x => x.revokeCommitMs));
    const visibilityStats = calcStats(rows.map(x => x.postCommitVisibilityMs));
    const enforcementStats = calcStats(rows.map(x => x.enforcementGapMs));

    const successCount = rows.filter(x => x.observedRevoked).length;

    console.log(`\nSummary for load=${loadConcurrency}:`);
    console.log(`  observed revoked: ${successCount}/${rows.length}`);
    console.log(
        `  Revoke commit latency: avg=${commitStats.avg.toFixed(3)} ms, ` +
        `median=${commitStats.median.toFixed(3)} ms, p95=${commitStats.p95.toFixed(3)} ms`
    );
    console.log(
        `  Post-commit visibility latency: avg=${visibilityStats.avg.toFixed(3)} ms, ` +
        `median=${visibilityStats.median.toFixed(3)} ms, p95=${visibilityStats.p95.toFixed(3)} ms`
    );
    console.log(
        `  Revocation-to-enforcement gap: avg=${enforcementStats.avg.toFixed(3)} ms, ` +
        `median=${enforcementStats.median.toFixed(3)} ms, p95=${enforcementStats.p95.toFixed(3)} ms`
    );
}

async function main() {
    const roundsArg = Number(process.argv[2]);
    const rounds = Number.isInteger(roundsArg) && roundsArg > 0 ? roundsArg : 10;

    const runTag = `${Date.now()}`;

    console.log('\n========== Fabric Revocation Enforcement Benchmark ==========');
    console.log(`Run tag: ${runTag}`);
    console.log(`Rounds per load level: ${rounds}`);
    console.log(`Load levels: ${loadLevels.join(', ')}`);
    console.log(`Background batch size: ${backgroundBatchSize}`);
    console.log(`Results file: ${resultsPath}`);

    const org1 = await getContract(1);
    const org2 = await getContract(2);

    try {
        await warmup(org1.contract, org2.contract);

        const backgroundPids = buildBackgroundDeviceIds(runTag);

        // 因为要测 load=8/16 下的撤销窗口，所以先准备一批背景查询设备。
        // 这一步大约需要 backgroundBatchSize × 2.1s。
        await prepareBackgroundDevices(org1.contract, backgroundPids);

        for (const load of loadLevels) {
            await runLoadScenario(
                runTag,
                load,
                rounds,
                org1.contract,
                org2.contract,
                backgroundPids
            );
        }

        console.log('\nAll revocation enforcement scenarios completed.');
        console.log(`Results saved to: ${resultsPath}`);
    } finally {
        org1.gateway.close();
        org1.client.close();
        org2.gateway.close();
        org2.client.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
