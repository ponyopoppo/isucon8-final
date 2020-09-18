import request, { SuperAgentTest } from 'supertest';
import { assert } from 'chai';
import { JSDOM } from 'jsdom';
import snapshot from 'snap-shot-it';
import app from './index';
import supertest from 'supertest';
import { Order } from './model/orders';
const agent = request.agent(app);
const agent2 = request.agent(app);

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

async function signupAndSignin(agent: request.SuperAgentTest) {
    await init();
    const bankId = `isucon-00${Math.random() * 9 + 1}`;
    await agent
        .post('/signup')
        .set('Accept', 'application/json')
        .query({})
        .send(`name=${bankId}&bank_id=${bankId}&password=test`);
    await agent
        .post('/signin')
        .set('Accept', 'application/json')
        .query({})
        .send(`bank_id=${bankId}&password=test`)
        .expect(200);
}

// describe('/info', () => {
//     it('should response something', async () => {
//         await signupAndSignin();

//         const response = await agent
//             .get('/info')
//             .set('Accept', 'application/json, text/plain, */*')
//             .query({})
//             .send({});

//         snapshot(JSON.parse(response.text));
//     });
// });

describe('/orders', () => {
    // it('should order', async () => {
    //     await signupAndSignin();

    //     const response = await agent
    //         .post('/orders')
    //         .set('Accept', 'application/json, text/plain, */*')
    //         .query({})
    //         .send('type=sell&amount=2&price=6')
    //         .expect(200);
    //     assert.isNumber(JSON.parse(response.text).id);
    // });

    // it('should get orders', async () => {
    //     await signupAndSignin();
    //     await agent
    //         .post('/orders')
    //         .set('Accept', 'application/json, text/plain, */*')
    //         .query({})
    //         .send('type=sell&amount=2&price=6')
    //         .expect(200);
    //     await agent
    //         .post('/orders')
    //         .set('Accept', 'application/json, text/plain, */*')
    //         .query({})
    //         .send('type=buy&amount=9&price=10')
    //         .expect(200);
    //     const response = await agent
    //         .get('/orders')
    //         .set('Accept', 'application/json, text/plain, */*')
    //         .query({})
    //         .send()
    //         .expect(200);
    //     snapshot(JSON.parse(response.text));
    // });

    async function postManyOrders(agent: supertest.SuperAgentTest) {
        await signupAndSignin(agent);
        let ids = await Promise.all(
            new Array(200).fill(0).map(async () => {
                try {
                    const res = await agent
                        .post('/orders')
                        .set('Accept', 'application/json, text/plain, */*')
                        .send(
                            `type=${
                                Math.random() < 0.5 ? 'sell' : 'buy'
                            }&amount=${Math.floor(
                                Math.random() * 10
                            )}&price=${Math.floor(Math.random() * 10)}`
                        )
                        .expect(200);
                    const { id } = JSON.parse(res.text);
                    return id;
                } catch (e) {
                    return null;
                }
            })
        );
        ids = ids.filter((id) => id);
        return ids;
    }

    async function getDelta(agent: SuperAgentTest) {
        const response = await agent
            .get('/orders')
            .set('Accept', 'application/json, text/plain, */*')
            .query({})
            .send()
            .expect(200);
        const orders: Order[] = JSON.parse(response.text);
        let sum = 0;
        for (const o of orders) {
            if (o.closed_at && o.trade) {
                if (o.type === 'sell') {
                    sum -= o.amount * o.trade.price;
                } else {
                    sum += o.amount * o.trade.price;
                }
            }
        }
        return sum;
    }

    it('should post many and get orders', async () => {
        const [ids1] = await Promise.all([
            postManyOrders(agent),
            postManyOrders(agent2),
        ]);
        const response = await agent
            .get('/orders')
            .set('Accept', 'application/json, text/plain, */*')
            .query({})
            .send()
            .expect(200);
        const orders = JSON.parse(response.text);
        const delta1 = await getDelta(agent);
        const delta2 = await getDelta(agent2);
        console.log({ delta1, delta2 });
        const actualIds = orders.map(({ id, trade, trade_id }: any) => {
            assert.isFalse(!!(trade_id && !trade));
            return id;
        });
        assert.sameMembers(ids1, actualIds);
    }).timeout(100000);
});
