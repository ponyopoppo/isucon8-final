import urljoin from 'url-join';
import fetch from 'node-fetch';

interface Data {
    tag: string;
    time: string;
    data: object;
}

let queue: Data[] = [];

export class IsuLogger {
    constructor(public endpoint: string, public appID: string) {
        setInterval(async () => {
            if (!queue.length) return;
            try {
                for (const data of queue) {
                    await this.request(data);
                }
                queue = [];
            } catch (e) {}
        }, 200);
    }

    async send(tag: string, data: object) {
        this.enqueue({
            tag,
            time: new Date().toISOString().replace(/\.[0-9]{3}Z/, '+09:00'),
            data,
        });
    }

    private async request(data: Data) {
        const url = urljoin(this.endpoint, '/send');
        const body = JSON.stringify(data);
        const headers = {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + this.appID,
        };
        const res = await fetch(url, { body, headers, method: 'POST' });
        if (res.status >= 300) {
            throw new Error(
                `failed isulogger request ${res.statusText} ${
                    res.status
                } ${await res.text()}`
            );
        }
    }

    private async enqueue(data: Data) {
        queue.push(data);
    }
}
