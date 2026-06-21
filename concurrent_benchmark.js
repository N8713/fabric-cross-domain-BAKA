'use strict';

const grpc = require('@grpc/grpc-js');
const { connect, hash, signers } = require('@hyperledger/fabric-gateway');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const channelName = 'mychannel';
const chaincodeName = 'iotcc';

const testNetworkPath = path.resolve(__dirname, '../test-network');
const resultsPath = path.resolve(__dirname, 'concurrent_results.csv');


const concurrencyLevels = [1, 2, 4, 8, 16, 32];


const roundsPerSetting = 20;


const sleepBetweenRoundsMs = 200;

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

async function timeMs(fn) {
    const start = process.hrtime.bigint();
    const result = await fn();
    const end = process.hrtime.bigint();

    return {
        ms: Number(end - start) / 1e6,
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
            p99: 0
        };
    }

    const sorted = [...values].sort((a, b) => a - b);
    const count = sorted.length;
    const total = sorted.reduce((a, b) => a + b, 0);
    const avg = total / count;
    const median = sorted[Math.floor(count / 2)];
    const p95 = sorted[Math.min(count - 1, Math.ceil(count * 0.95) - 1)];
    const p99 = sorted[Math.min(count - 1, Math.ceil(count * 0.99) - 1)];

    return {
        count,
        total,
        avg,
        median,
        p95,
        p99
    };
}

async function appendCsv(row) {
    const header = [
        'run_tag',
        'batch_size',
        'concurrency',
        'rounds',
        'total_requests',
        'success',
        'failed',
        'total_wall_time_ms',
        'avg_latency_ms',
        'median_latency_ms',
        'p95_latency_ms',
        'p99_latency_ms',
        'throughput_batch_per_sec',
        'throughput_device_per_sec'
    ].join(',') + '\n';

    try {
        await fs.access(resultsPath);
    } catch {
        await fs.writeFile(resultsPath, header);
    }

    const line = [
        row.runTag,
        row.batchSize,
        row.concurrency,
        row.rounds,
        row.totalRequests,
        row.success,
        row.failed,
        row.totalWallTimeMs.toFixed(3),
        row.avgLatencyMs.toFixed(3),
        row.medianLatencyMs.toFixed(3),
        row.p95LatencyMs.toFixed(3),
        row.p99LatencyMs.toFixed(3),
        row.throughputBatchPerSec.toFixed(3),
        row.throughputDevicePerSec.toFixed(3)
    ].join(',') + '\n';

    await fs.appendFile(resultsPath, line);
}

async function warmup(org1Contract, org2Contract) {
    const pid = `WARMUP_CONCURRENT_${Date.now()}`;

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
    } catch (error) {
        console.log(`Warmup warning: ${error.message}`);
    }
}

function buildDeviceIds(runTag, maxN) {
    const pids = [];

    for (let i = 0; i < maxN; i++) {
        pids.push(`SD_A_CONCURRENT_${runTag}_${i}`);
    }

    return pids;
}

async function prepareDevices(org1Contract, pids) {
    console.log(`\nPreparing ${pids.length} devices for concurrent query benchmark...`);

    const latencies = [];

    for (let i = 0; i < pids.length; i++) {
        const pid = pids[i];

        const t = await timeMs(() =>
            org1Contract.submitTransaction(
                'RegisterDevice',
                pid,
                randomHex(),
                randomHex(),
                'DomainA'
            )
        );

        latencies.push(t.ms);

        if ((i + 1) % 10 === 0 || i + 1 === pids.length) {
            console.log(`  Registered ${i + 1}/${pids.length}`);
        }
    }

    const stats = calcStats(latencies);

    console.log(
        `Device preparation completed: count=${stats.count}, ` +
        `total=${stats.total.toFixed(3)} ms, avg=${stats.avg.toFixed(3)} ms, ` +
        `p95=${stats.p95.toFixed(3)} ms`
    );
}

async function createQueryClients(concurrency) {
    const clients = [];

    for (let i = 0; i < concurrency; i++) {
        const org2 = await getContract(2);
        clients.push(org2);
    }

    return clients;
}

function closeQueryClients(clients) {
    for (const c of clients) {
        try {
            c.gateway.close();
        } catch {}

        try {
            c.client.close();
        } catch {}
    }
}

async function runOneRound(queryClients, pids, concurrency) {
    const latencies = [];
    let success = 0;
    let failed = 0;

    const roundStart = process.hrtime.bigint();

    const tasks = [];

    for (let i = 0; i < concurrency; i++) {
        const contract = queryClients[i].contract;

        const task = (async () => {
            const start = process.hrtime.bigint();

            try {
                await contract.evaluateTransaction(
                    'QueryDevices',
                    JSON.stringify(pids)
                );

                const end = process.hrtime.bigint();
                latencies.push(Number(end - start) / 1e6);
                success++;
            } catch (error) {
                const end = process.hrtime.bigint();
                latencies.push(Number(end - start) / 1e6);
                failed++;
                console.error(`QueryDevices failed: ${error.message}`);
            }
        })();

        tasks.push(task);
    }

    await Promise.all(tasks);

    const roundEnd = process.hrtime.bigint();
    const wallTimeMs = Number(roundEnd - roundStart) / 1e6;

    return {
        wallTimeMs,
        latencies,
        success,
        failed
    };
}

async function runConcurrentSetting(runTag, batchSize, concurrency, pidsForBatch) {
    console.log(`\n========== Concurrent QueryDevices: n=${batchSize}, c=${concurrency} ==========`);

    const queryClients = await createQueryClients(concurrency);

    const allLatencies = [];
    let totalSuccess = 0;
    let totalFailed = 0;
    let totalWallTimeMs = 0;

    try {
        for (let round = 0; round < roundsPerSetting; round++) {
            const r = await runOneRound(queryClients, pidsForBatch, concurrency);

            allLatencies.push(...r.latencies);
            totalSuccess += r.success;
            totalFailed += r.failed;
            totalWallTimeMs += r.wallTimeMs;

            const roundStats = calcStats(r.latencies);

            console.log(
                `Round ${round + 1}/${roundsPerSetting}: ` +
                `success=${r.success}, failed=${r.failed}, ` +
                `wall=${r.wallTimeMs.toFixed(3)} ms, ` +
                `avg=${roundStats.avg.toFixed(3)} ms, ` +
                `p95=${roundStats.p95.toFixed(3)} ms`
            );

            await sleep(sleepBetweenRoundsMs);
        }
    } finally {
        closeQueryClients(queryClients);
    }

    const stats = calcStats(allLatencies);

    const totalWallTimeSec = totalWallTimeMs / 1000.0;
    const throughputBatchPerSec = totalSuccess / totalWallTimeSec;
    const throughputDevicePerSec = totalSuccess * batchSize / totalWallTimeSec;

    await appendCsv({
        runTag,
        batchSize,
        concurrency,
        rounds: roundsPerSetting,
        totalRequests: totalSuccess + totalFailed,
        success: totalSuccess,
        failed: totalFailed,
        totalWallTimeMs,
        avgLatencyMs: stats.avg,
        medianLatencyMs: stats.median,
        p95LatencyMs: stats.p95,
        p99LatencyMs: stats.p99,
        throughputBatchPerSec,
        throughputDevicePerSec
    });

    console.log(
        `Summary: n=${batchSize}, c=${concurrency}, ` +
        `requests=${totalSuccess + totalFailed}, success=${totalSuccess}, failed=${totalFailed}, ` +
        `avg=${stats.avg.toFixed(3)} ms, median=${stats.median.toFixed(3)} ms, ` +
        `p95=${stats.p95.toFixed(3)} ms, p99=${stats.p99.toFixed(3)} ms, ` +
        `throughput=${throughputBatchPerSec.toFixed(3)} batch/s, ` +
        `deviceThroughput=${throughputDevicePerSec.toFixed(3)} device/s`
    );
}

async function main() {
    const scenarios = process.argv.slice(2).map(Number);

    if (scenarios.length === 0) {
        console.log('Usage: node concurrent_benchmark.js 10 25 50 100 200');
        process.exit(1);
    }

    for (const n of scenarios) {
        if (!Number.isInteger(n) || n <= 0) {
            throw new Error(`Invalid n: ${n}`);
        }
    }

    const maxN = Math.max(...scenarios);
    const runTag = `${Date.now()}`;

    console.log('\n========== Fabric Concurrent Query Benchmark ==========');
    console.log(`Run tag: ${runTag}`);
    console.log(`Batch sizes: ${scenarios.join(', ')}`);
    console.log(`Max registered devices: ${maxN}`);
    console.log(`Concurrency levels: ${concurrencyLevels.join(', ')}`);
    console.log(`Rounds per setting: ${roundsPerSetting}`);
    console.log(`Results file: ${resultsPath}`);

    // 为避免重复追加旧结果，启动前删除旧 concurrent_results.csv 即可。
    // 这里不自动删除，防止误删历史结果。

    const org1 = await getContract(1);
    const org2 = await getContract(2);

    try {
        await warmup(org1.contract, org2.contract);

        // 只注册 maxN 个设备。
        // 对 n=10,25,50,100,200 的实验分别取前 n 个设备。
        // 这样可以减少注册次数，避免重复注册 10+25+50+100+200 个设备。
        const allPids = buildDeviceIds(runTag, maxN);

        await prepareDevices(org1.contract, allPids);

        for (const n of scenarios) {
            const pidsForBatch = allPids.slice(0, n);

            for (const c of concurrencyLevels) {
                await runConcurrentSetting(runTag, n, c, pidsForBatch);
            }
        }

        console.log('\nAll concurrent query scenarios completed.');
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
