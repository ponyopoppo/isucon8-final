import urljoin from 'url-join';
import axios from 'axios';

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
                const data = [...queue];
                queue = [];
                await this.request(data);
            } catch (e) {
                console.log('logger error!!', e);
            }
        }, 200);
    }

    async send(tag: string, data: object) {
        this.enqueue({
            tag,
            time: new Date().toISOString().replace(/\.[0-9]{3}Z/, '+09:00'),
            data,
        });
    }

    private async request(data: Data[]) {
        const url = urljoin(this.endpoint, '/send_bulk');
        const body = JSON.stringify(data);
        const headers = {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + this.appID,
        };
        const res = await axios.post(url, body, { headers });
        if (res.status >= 300) {
            throw new Error(
                `failed isulogger request ${res.statusText} ${res.status} ${res.data}`
            );
        }
    }

    private async enqueue(data: Data) {
        queue.push(data);
    }
}
