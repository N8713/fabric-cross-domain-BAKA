'use strict';

const { Contract } = require('fabric-contract-api');

class IIoTContract extends Contract {
    deviceKey(pid) {
        return `DEVICE_${pid}`;
    }

    edgeKey(edgeId) {
        return `EDGE_${edgeId}`;
    }

    async DeviceExists(ctx, pid) {
        const buffer = await ctx.stub.getState(this.deviceKey(pid));
        return buffer && buffer.length > 0;
    }

    async EdgeExists(ctx, edgeId) {
        const buffer = await ctx.stub.getState(this.edgeKey(edgeId));
        return buffer && buffer.length > 0;
    }

    async RegisterDevice(ctx, pid, pkx, pky, domain) {
        if (!pid || !pkx || !pky || !domain) {
            throw new Error('RegisterDevice requires pid, pkx, pky, and domain.');
        }

        const exists = await this.DeviceExists(ctx, pid);
        if (exists) {
            throw new Error(`Device ${pid} already exists.`);
        }

        const device = {
            type: 'device',
            pid,
            pkx,
            pky,
            domain,
            valid: true
        };

        await ctx.stub.putState(this.deviceKey(pid), Buffer.from(JSON.stringify(device)));
        return JSON.stringify(device);
    }

    async RegisterEdge(ctx, edgeId, pkx, pky, domain) {
        if (!edgeId || !pkx || !pky || !domain) {
            throw new Error('RegisterEdge requires edgeId, pkx, pky, and domain.');
        }

        const exists = await this.EdgeExists(ctx, edgeId);
        if (exists) {
            throw new Error(`Edge node ${edgeId} already exists.`);
        }

        const edge = {
            type: 'edge',
            edgeId,
            pkx,
            pky,
            domain,
            valid: true
        };

        await ctx.stub.putState(this.edgeKey(edgeId), Buffer.from(JSON.stringify(edge)));
        return JSON.stringify(edge);
    }

    async QueryDevice(ctx, pid) {
        const buffer = await ctx.stub.getState(this.deviceKey(pid));
        if (!buffer || buffer.length === 0) {
            throw new Error(`Device ${pid} does not exist.`);
        }

        return buffer.toString();
    }

    async QueryDevices(ctx, pidListJson) {
        let pidList;
        try {
            pidList = JSON.parse(pidListJson);
        } catch (error) {
            throw new Error('QueryDevices requires a JSON array of PIDs.');
        }

        if (!Array.isArray(pidList)) {
            throw new Error('QueryDevices input must be a JSON array.');
        }

        const results = [];

        for (const pid of pidList) {
            const buffer = await ctx.stub.getState(this.deviceKey(pid));

            if (!buffer || buffer.length === 0) {
                results.push({
                    pid,
                    found: false,
                    valid: false
                });
            } else {
                const device = JSON.parse(buffer.toString());
                results.push({
                    pid: device.pid,
                    pkx: device.pkx,
                    pky: device.pky,
                    domain: device.domain,
                    valid: device.valid,
                    found: true
                });
            }
        }

        return JSON.stringify(results);
    }

    async UpdateDevice(ctx, pid, pkx, pky, domain) {
        if (!pid || !pkx || !pky || !domain) {
            throw new Error('UpdateDevice requires pid, pkx, pky, and domain.');
        }

        const exists = await this.DeviceExists(ctx, pid);
        if (!exists) {
            throw new Error(`Device ${pid} does not exist.`);
        }

        const updatedDevice = {
            type: 'device',
            pid,
            pkx,
            pky,
            domain,
            valid: true
        };

        await ctx.stub.putState(this.deviceKey(pid), Buffer.from(JSON.stringify(updatedDevice)));
        return JSON.stringify(updatedDevice);
    }

    async RevokeDevice(ctx, pid) {
        const buffer = await ctx.stub.getState(this.deviceKey(pid));
        if (!buffer || buffer.length === 0) {
            throw new Error(`Device ${pid} does not exist.`);
        }

        const device = JSON.parse(buffer.toString());
        device.valid = false;

        await ctx.stub.putState(this.deviceKey(pid), Buffer.from(JSON.stringify(device)));
        return JSON.stringify(device);
    }
}

module.exports = IIoTContract;
