'use strict';

const grpc = require('@grpc/grpc-js');
const { connect, hash, signers } = require('@hyperledger/fabric-gateway');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const channelName = 'mychannel';
const chaincodeName = 'iotcc';

const testNetworkPath = path.resolve(__dirname, '../test-network');
const resultsPath = path.resolve(__dirname, 'results.csv');

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
            return { deadline: Date.now() + 15000 };
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
        p95
    };
}

async function appendCsv(row) {
    const header = 'run_tag,n,operation,count,total_ms,avg_ms,median_ms,p95_ms,per_device_ms\n';

    try {
        await fs.access(resultsPath);
    } catch {
        await fs.writeFile(resultsPath, header);
    }

    const line = [
        row.runTag,
        row.n,
        row.operation,
        row.count,
        row.total.toFixed(3),
        row.avg.toFixed(3),
        row.median.toFixed(3),
        row.p95.toFixed(3),
        row.perDevice.toFixed(3)
    ].join(',') + '\n';

    await fs.appendFile(resultsPath, line);
}

async function record(runTag, n, operation, values, perDeviceDivisor = null) {
    const s = calcStats(values);
    const perDevice = perDeviceDivisor ? s.total / perDeviceDivisor : s.avg;

    await appendCsv({
        runTag,
        n,
        operation,
        count: s.count,
        total: s.total,
        avg: s.avg,
        median: s.median,
        p95: s.p95,
        perDevice
    });

    console.log(
        `${operation}, n=${n}, count=${s.count}, total=${s.total.toFixed(3)} ms, ` +
        `avg=${s.avg.toFixed(3)} ms, median=${s.median.toFixed(3)} ms, ` +
        `p95=${s.p95.toFixed(3)} ms, perDevice=${perDevice.toFixed(3)} ms`
    );
}

async function warmup(org1Contract, org2Contract) {
    const pid = `WARMUP_${Date.now()}`;

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

async function runScenario(n) {
    const runTag = `${Date.now()}_${n}`;

    console.log(`\n========== Running scenario n=${n} ==========`);
    console.log(`Run tag: ${runTag}`);

    const org1 = await getContract(1);
    const org2 = await getContract(2);

    try {
        const org1Contract = org1.contract;
        const org2Contract = org2.contract;

        await warmup(org1Contract, org2Contract);

        const pids = [];

        const registerDeviceLatencies = [];
        for (let i = 0; i < n; i++) {
            const pid = `SD_A_${runTag}_${i}`;
            pids.push(pid);

            const t = await timeMs(() =>
                org1Contract.submitTransaction(
                    'RegisterDevice',
                    pid,
                    randomHex(),
                    randomHex(),
                    'DomainA'
                )
            );

            registerDeviceLatencies.push(t.ms);
        }

        await record(runTag, n, 'RegisterDevice', registerDeviceLatencies);

        const edgeId = `ES_B_${runTag}`;
        const registerEdgeTime = await timeMs(() =>
            org2Contract.submitTransaction(
                'RegisterEdge',
                edgeId,
                randomHex(),
                randomHex(),
                'DomainB'
            )
        );

        await record(runTag, n, 'RegisterEdge', [registerEdgeTime.ms]);

        const queryDeviceLatencies = [];
        for (const pid of pids) {
            const t = await timeMs(() =>
                org2Contract.evaluateTransaction('QueryDevice', pid)
            );

            queryDeviceLatencies.push(t.ms);
        }

        await record(runTag, n, 'QueryDevice', queryDeviceLatencies);

        const batchQueryTime = await timeMs(() =>
            org2Contract.evaluateTransaction(
                'QueryDevices',
                JSON.stringify(pids)
            )
        );

        await record(runTag, n, 'QueryDevices', [batchQueryTime.ms], n);

        const updateDeviceLatencies = [];
        for (const pid of pids) {
            const t = await timeMs(() =>
                org1Contract.submitTransaction(
                    'UpdateDevice',
                    pid,
                    randomHex(),
                    randomHex(),
                    'DomainA'
                )
            );

            updateDeviceLatencies.push(t.ms);
        }

        await record(runTag, n, 'UpdateDevice', updateDeviceLatencies);

        const revokeDeviceLatencies = [];
        for (const pid of pids) {
            const t = await timeMs(() =>
                org1Contract.submitTransaction('RevokeDevice', pid)
            );

            revokeDeviceLatencies.push(t.ms);
        }

        await record(runTag, n, 'RevokeDevice', revokeDeviceLatencies);

        console.log(`Scenario n=${n} completed.`);
    } finally {
        org1.gateway.close();
        org1.client.close();
        org2.gateway.close();
        org2.client.close();
    }
}

async function main() {
    const scenarios = process.argv.slice(2).map(Number);

    if (scenarios.length === 0) {
        console.log('Usage: node benchmark.js 10 25 50 100 200');
        process.exit(1);
    }

    for (const n of scenarios) {
        if (!Number.isInteger(n) || n <= 0) {
            throw new Error(`Invalid n: ${n}`);
        }

        await runScenario(n);
    }

    console.log(`\nAll scenarios completed.`);
    console.log(`Results saved to: ${resultsPath}`);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
