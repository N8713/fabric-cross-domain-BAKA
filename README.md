\# Fabric Prototype for Blockchain-Assisted Cross-Domain Batch AKA



This repository provides the Hyperledger Fabric chaincode and benchmark scripts used in the prototype evaluation of the paper:



\*\*Blockchain-Assisted Cross-Domain Batch Authentication and Key Agreement Scheme for IIoT\*\*



The prototype is built on the Hyperledger Fabric `test-network` and is used to evaluate on-chain entity registration, state update, revocation, single-device query, batch-device query, concurrent batch query, and revocation-enforcement latency.



\## 1. Prototype Overview



The prototype implements a two-organization Fabric network, where Org1 represents Domain A and Org2 represents Domain B. The chaincode maintains public registration and validity states of devices and edge servers. Only public parameters are stored on-chain, including pseudonyms, public keys, domain identifiers, and validity states. Real identities, private keys, and session keys are not stored on-chain.



The chaincode supports the following operations:



\- `RegisterDevice`: register a smart device.

\- `RegisterEdge`: register an edge server.

\- `UpdateDevice`: update the public state of a smart device.

\- `RevokeDevice`: revoke a smart device by setting its validity state to invalid.

\- `QueryDevice`: query the public state of a single smart device.

\- `QueryDevices`: query the public states of multiple smart devices in a batch manner.



\## 2. Repository Structure



```text

.

├── benchmark.js

├── concurrent\_benchmark.js

├── revocation\_delay\_benchmark.js

├── deployCC.sh

├── index.js

├── iot-contract.js

├── package.json

├── fabric\_results\_final.csv

├── concurrent\_results.csv

└── revocation\_delay\_results.csv



iot-contract.js: chaincode implementation for entity registration, update, revocation, and query.

index.js: chaincode entry file.

benchmark.js: benchmark script for basic Fabric operations, including registration, update, revocation, single-device query, and batch-device query.

concurrent\_benchmark.js: benchmark script for concurrent QueryDevices requests.

revocation\_delay\_benchmark.js: benchmark script for revocation-to-enforcement latency under background query loads.

deployCC.sh: helper script for chaincode deployment.

fabric\_results\_final.csv: experimental results for basic Fabric operations.

concurrent\_results.csv: experimental results for concurrent batch query evaluation.

revocation\_delay\_results.csv: experimental results for revocation-enforcement latency.

3\. Experimental Environment



The prototype was evaluated under the following environment:



Ubuntu 22.04.1 LTS

Docker 29.4.3

Docker Compose v5.1.3

Node.js v20.20.2

npm 10.8.2

Hyperledger Fabric v2.5.15

Fabric-CA v1.5.17

4\. Usage

4.1 Start the Fabric test-network



Start the Fabric test-network and create a channel:



cd fabric-samples/test-network

./network.sh down

./network.sh up createChannel

4.2 Deploy the chaincode



Place this repository in the same workspace as fabric-samples, and deploy the chaincode:



./network.sh deployCC -ccn iotcc -ccp ../../fabric-cross-domain-batch-aka -ccl javascript



Alternatively, adjust the chaincode path in deployCC.sh according to your local Fabric directory structure.



4.3 Install dependencies

npm install

4.4 Run basic Fabric operation benchmark

node benchmark.js 10 25 50 100 200

4.5 Run concurrent batch query benchmark

node concurrent\_benchmark.js

4.6 Run revocation-enforcement latency benchmark

node revocation\_delay\_benchmark.js

5\. Notes



This repository only contains the chaincode, benchmark scripts, and experimental result files used for the Fabric prototype evaluation.



The repository does not include Fabric-generated certificates, private keys, MSP folders, wallet files, or other sensitive deployment artifacts. Users should generate these files locally by starting the Fabric test-network.



Due to differences in hardware resources, Docker configuration, and Fabric runtime conditions, the absolute latency values may vary across environments. However, the scripts can be used to reproduce the experimental procedure and observe the performance trends reported in the paper.



