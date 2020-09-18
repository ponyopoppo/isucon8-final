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

async function signupAndSignin() {
    await init();
    await agent
        .post('/signup')
        .set('Accept', 'application/json')
        .query({})
        .send('name=test&bank_id=isucon-001&password=test');
    await agent
        .post('/signin')
        .set('Accept', 'application/json')
        .query({})
        .send('bank_id=isucon-001&password=test')
        .expect(200);
}

describe('/info', () => {
    it('should response something', async () => {
        await signupAndSignin();

        const response = await agent
            .get('/info')
            .set('Accept', 'application/json, text/plain, */*')
            .query({})
            .send({});

        snapshot(JSON.parse(response.text));
    });
});

// describe('/orders', () => {
//     it('should response something', async () => {
//         await signupAndSignin();

//         const response = await agent
//             .post('/orders')
//             .set('Accept', 'application/json, text/plain, */*')
//             .query({})
//             .send('type=sell&amount=2&price=6')
//             .expect(200);
//         assert.isNumber(JSON.parse(response.text).id);
//     });
// });
