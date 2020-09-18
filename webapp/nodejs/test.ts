import request from 'supertest';
import { assert } from 'chai';
import { JSDOM } from 'jsdom';
import snapshot from 'snap-shot-it';
import app from './index';
const agent = request.agent(app);

async function init() {
    await agent
        .post('/initialize')
        .set('Content-Type', 'application/json')
        .send({
            bank_endpoint: 'http://localhost:14809',
            bank_appid: 'mockbank',
            log_endpoint: 'http://localhost:14690',
            log_appid: 'mocklog',
        });
}

describe('/signup', () => {
    it('should signup', async () => {
        await init();
        const response = await agent
            .post('/signup')
            .set('Accept', 'application/json')
            .query({})
            .send('name=test&bank_id=isucon-001&password=test');
        snapshot(response.text);
    });
});

describe('/info', () => {
    it('should response something', async () => {
        const response = await agent
            .get('/info')
            .set('Accept', 'application/json, text/plain, */*')
            .query({})
            .send({});

        snapshot(response.text);
    });
});
