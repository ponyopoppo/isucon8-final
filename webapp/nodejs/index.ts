import express from 'express';
import log4js from 'log4js';
import session from 'express-session';
import { promisify } from 'util';
import path from 'path';
import bodyParser from 'body-parser';
import morgan from 'morgan';
import { initBenchmark } from './model';
import { setSetting } from './model/settings';
import {
    addOrder,
    deleteOrder,
    fetchOrderRelation,
    getHighestBuyOrder,
    getLowestSellOrder,
    getOrdersByUserId,
    getOrdersByUserIdAndLasttradeid,
    Order,
} from './model/orders';
import { dbQuery, getConnection, transaction } from './db';
import {
    BankUserConflict,
    BankUserNotFound,
    getUserById,
    login,
    signup,
    User,
} from './model/users';
import {
    addCacheTrade,
    getCacheCandlestick,
    getLatestTrade,
    getTradeById,
    hasTradeChanceByOrder,
    resetCacheTrade,
    runTrade,
} from './model/trades';
import StopWatch from '@ponyopoppo/node-stop-watch';
StopWatch.disableAll();
declare global {
    namespace Express {
        export interface Request {
            currentUser?: {
                id: number;
                bank_id: string;
                name: string;
                password: string;
                created_at: Date;
            };
        }
    }
}

const logger = log4js.getLogger();

const app = express();
app.use(morgan('tiny'));

const PUBLIC_DIR = process.env.ISU_PUBLIC_DIR || 'public';

/*
 * ISUCON用初期データの基準時間です
 * この時間以降のデータはinitializeで削除されます
 */
const BASE_TIME = new Date(2018, 10 - 1, 16, 10, 0, 0);

function sendError(res: express.Response, code: number, msg: string) {
    res.set('X-Content-Type-Options', 'nosniff');
    res.status(code).json({ code, msg });
}

app.use(express.static(PUBLIC_DIR));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(session({ secret: 'tonymoris' }));

app.use(async function beforeRequest(req, res, next) {
    const userId = req.session?.userId;
    if (!userId) {
        req.currentUser = undefined;
        next();
        return;
    }
    const db = await getConnection();
    const user = await getUserById(db, userId);
    if (!user) {
        await promisify(req.session!.destroy.bind(req.session!))();
        db.release();
        return sendError(res, 404, 'セッションが切断されました');
    }
    req.currentUser = user;
    db.release();
    next();
});

app.get('/', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.post('/initialize', async (req, res) => {
    const db = await getConnection();
    await transaction(db, async () => {
        await initBenchmark(db);
    });
    console.log('body', req.body);
    resetCacheTrade();
    const trades = await dbQuery(db, 'SELECT * FROM trade');
    console.log(trades.length);
    for (const trade of trades) {
        addCacheTrade(trade);
    }
    for (const k of [
        'bank_endpoint',
        'bank_appid',
        'log_endpoint',
        'log_appid',
    ]) {
        const v = req.body[k];
        await setSetting(db, k, v);
    }
    db.release();
    res.json({});
});

app.post('/signup', async (req, res, next) => {
    const { name, bank_id, password } = req.body;
    if (!(name && bank_id && password)) {
        sendError(res, 400, 'all parameters are required');
        return;
    }
    const db = await getConnection();
    try {
        await transaction(db, async () => {
            await signup(db, name, bank_id, password);
        });
    } catch (e) {
        if (e instanceof BankUserNotFound) {
            sendError(res, 404, e.message);
            return;
        }
        if (e instanceof BankUserConflict) {
            sendError(res, 409, e.message);
            return;
        }
        next(e);
        return;
    } finally {
        db.release();
    }
    res.json({});
});

app.post('/signin', async (req, res) => {
    const { bank_id, password } = req.body;
    if (!(bank_id && password)) {
        sendError(res, 400, 'all parameters are required');
        return;
    }

    let user;
    const db = await getConnection();
    try {
        user = await login(db, bank_id, password);
    } catch (e) {
        return sendError(res, 404, e.message);
    } finally {
        db.release();
    }

    req.session!.userId = user.id;
    res.json({ id: user.id, name: user.name });
});

app.post('/signout', async (req, res) => {
    await promisify(req.session!.destroy)();
    res.json({});
});

app.get('/info', async (req, res) => {
    const sw = new StopWatch('info');
    const info: any = {};
    const { cursor } = req.query;
    let lastTradeId = 0;
    let lastTradeDate = null;
    sw.record('1');
    const db = await getConnection();
    if (cursor) {
        try {
            lastTradeId = parseInt(cursor as string);
        } catch (e) {
            logger.error(`failed to parse cursor (${cursor})`);
        }
        if (lastTradeId > 0) {
            const trade = await getTradeById(db, lastTradeId);
            if (trade) {
                lastTradeDate = trade.created_at;
            }
        }
    }
    sw.record('2');
    const latestTrade = await getLatestTrade(db);
    info.cursor = latestTrade!.id;
    const user = req.currentUser;
    sw.record('2.5');
    if (user) {
        const orders = await getOrdersByUserIdAndLasttradeid(
            db,
            user.id,
            lastTradeId
        );
        sw.record('2.75');
        for (const o of orders) {
            await fetchOrderRelation(db, o);
        }
        info.traded_orders = orders;
    }
    sw.record('3');
    let fromT = new Date(BASE_TIME.getTime() - 300 * 1000);
    if (lastTradeDate && lastTradeDate > fromT) {
        fromT = new Date(lastTradeDate);
        fromT.setMilliseconds(0);
    }
    info.chart_by_sec = getCacheCandlestick(fromT, 'secondly');
    sw.record('3.1');
    fromT = new Date(BASE_TIME.getTime() - 300 * 60 * 1000);
    if (lastTradeDate && lastTradeDate > fromT) {
        fromT = new Date(lastTradeDate);
        fromT.setMilliseconds(0);
        fromT.setSeconds(0);
    }
    info.chart_by_min = getCacheCandlestick(fromT, 'minutely');
    sw.record('3.2');
    fromT = new Date(BASE_TIME.getTime() - 48 * 60 * 60 * 1000);
    if (lastTradeDate && lastTradeDate > fromT) {
        fromT = new Date(lastTradeDate);
        fromT.setMilliseconds(0);
        fromT.setSeconds(0);
        fromT.setMinutes(0);
    }
    info.chart_by_hour = getCacheCandlestick(fromT, 'hourly');
    sw.record('3.3');
    const lowestSellOrder = await getLowestSellOrder(db);
    if (lowestSellOrder) {
        info.lowest_sell_price = lowestSellOrder.price;
    }
    sw.record('3.4');
    const highestBuyOrder = await getHighestBuyOrder(db);
    if (highestBuyOrder) {
        info.highest_buy_price = highestBuyOrder.price;
    }
    sw.record('4');
    info.enable_share = false;
    db.release();
    res.json(info);
});

app.get('/orders', async (req, res) => {
    const user = req.currentUser;
    if (!user) {
        return sendError(res, 401, 'Not authenticated');
    }
    const db = await getConnection();
    const orders = await getOrdersByUserId(db, user.id);
    for (const o of orders) {
        await fetchOrderRelation(db, o);
    }
    db.release();
    res.json(orders);
});

app.post('/orders', async (req, res) => {
    const sw = new StopWatch('orders');
    const user = req.currentUser;
    if (!user) {
        return sendError(res, 401, 'Not authenticated');
    }
    sw.record('1');
    const amount = parseInt(req.body.amount);
    const price = parseInt(req.body.price);
    const type = req.body.type;
    const db = await getConnection();
    let order: Order | undefined;
    try {
        await transaction(db, async () => {
            order = await addOrder(db, type, user.id, amount, price);
        });
    } catch (e) {
        if (e.message !== 'value error') {
            console.log('error', e);
        }
        db.release();
        return sendError(res, 400, e.message);
    }
    sw.record('2');
    if (!order) {
        db.release();
        return sendError(res, 400, 'hogehoge');
    }
    const tradeChance = await hasTradeChanceByOrder(db, order.id);
    sw.record('3');
    if (tradeChance) {
        try {
            await runTrade(db);
        } catch (e) {
            // トレードに失敗してもエラーにはしない
            logger.error('run_trade failed');
        }
    }
    sw.record('4');
    db.release();
    res.json({ id: order!.id });
});

app.delete('/order/:id', async (req, res) => {
    const { id } = req.params;
    const orderId = parseInt(id);
    const user = req.currentUser;
    if (!user) {
        return sendError(res, 401, 'Not authenticated');
    }

    const db = await getConnection();
    try {
        await transaction(db, async () => {
            await deleteOrder(db, user.id, orderId, 'canceled');
        });
    } catch (e) {
        db.release();
        return sendError(res, 404, e.message);
    }
    db.release();
    res.json({ id: orderId });
});

app.get('/stopwatch', (_, res) => {
    res.send(StopWatch.renderResult());
});

app.use(function errorHandler(
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
) {
    logger.error('FAIL');
    sendError(res, 500, err.message);
});

const PORT = process.env.ISU_APP_PORT || 5000;
app.listen(PORT, function listeningListener() {
    console.log(`listening on ${PORT}`);
});

export default app;
