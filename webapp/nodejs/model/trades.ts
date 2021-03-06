import db, { dbQuery } from '../db';
import {
    cancelOrder,
    CreditInsufficient,
    getHighestBuyCache,
    getHighestBuyOrder,
    getLowestSellCache,
    getLowestSellOrder,
    getOpenOrderById,
    getOrderById,
    Order,
    OrderAlreadyClosed,
    resetHighestBuyCache,
    resetLowesetSellCache,
} from './orders';
import { getIsubank, sendLog } from './settings';
import { promisify } from 'util';
import { Connection } from 'mysql';
import StopWatch from '@ponyopoppo/node-stop-watch';

class NoOrderForTrade extends Error {
    constructor() {
        super('no order for trade');
        Object.setPrototypeOf(this, NoOrderForTrade.prototype);
    }
}

export class Trade {
    constructor(
        public id: number,
        public amount: number,
        public price: number,
        public created_at: Date
    ) {}
}

class CandlestickData {
    constructor(
        public time: Date,
        public open: number,
        public close: number,
        public high: number,
        public lower: number
    ) {}
}

interface Candle {
    t: Date;
    open: number;
    close: number;
    h: number;
    l: number;
    minId: number;
    maxId: number;
}

let minutelySum: {
    [key: string]: Candle;
} = {};
let minKeys: number[] = [];

let hourlySum: {
    [key: string]: Candle;
} = {};
let hourKeys: number[] = [];

let secondlySum: {
    [key: string]: Candle;
} = {};
let secondKeys: number[] = [];

function updateSum(
    date: Date,
    sum: { [key: string]: Candle },
    trade: Trade,
    keys: number[]
) {
    const key = date.getTime();
    if (!sum[key]) {
        sum[key] = {
            t: date,
            open: trade.price,
            close: trade.price,
            h: trade.price,
            l: trade.price,
            minId: trade.id,
            maxId: trade.id,
        };
        keys.push(key);
    } else {
        if (trade.id < sum[key].minId) {
            sum[key].minId = trade.id;
            sum[key].open = trade.price;
        }
        if (trade.id > sum[key].maxId) {
            sum[key].maxId = trade.id;
            sum[key].close = trade.price;
        }
        if (trade.price < sum[key].l) {
            sum[key].l = trade.price;
        }
        if (trade.price > sum[key].h) {
            sum[key].h = trade.price;
        }
    }
}

export function addCacheTrade(trade: Trade) {
    const hdate = new Date(trade.created_at);
    hdate.setMinutes(0);
    hdate.setSeconds(0);
    hdate.setMilliseconds(0);
    updateSum(hdate, hourlySum, trade, hourKeys);
    const mdate = new Date(trade.created_at);
    mdate.setSeconds(0);
    mdate.setMilliseconds(0);
    updateSum(mdate, minutelySum, trade, minKeys);
    const sdate = new Date(trade.created_at);
    sdate.setMilliseconds(0);
    updateSum(sdate, secondlySum, trade, secondKeys);
}

export function resetCacheTrade() {
    hourlySum = {};
    hourKeys = [];
    minutelySum = {};
    minKeys = [];
    secondlySum = {};
    secondKeys = [];
}

function findMinKeyPos(keys: number[], lowerBound: number) {
    let lower = -1;
    let upper = keys.length - 1;
    while (upper - lower > 1) {
        let mid = Math.floor((upper + lower) / 2);
        if (keys[mid] < lowerBound) {
            lower = mid;
        } else {
            upper = mid;
        }
    }
    return upper;
}

export function getCacheCandlestick(
    lowerBound: Date,
    type: 'minutely' | 'hourly' | 'secondly'
): CandlestickData[] {
    let sum = minutelySum;
    let keys = minKeys;
    if (type === 'hourly') {
        sum = hourlySum;
        keys = hourKeys;
    } else if (type === 'secondly') {
        sum = secondlySum;
        keys = secondKeys;
    }
    const result = [] as Candle[];
    for (
        let pos = findMinKeyPos(keys, lowerBound.getTime());
        pos < keys.length;
        pos++
    ) {
        result.push(sum[keys[pos]]);
    }
    return result.map(
        (row: Candle) =>
            new CandlestickData(row.t, row.open, row.close, row.h, row.l)
    );
}

async function getTrade(
    db: Connection,
    query: string,
    ...args: any[]
): Promise<Trade | null> {
    const [row] = await dbQuery(db, query, args);
    if (!row) return null;
    return new Trade(row.id, row.amount, row.price, row.created_at);
}

export async function getTradeById(db: Connection, id: number) {
    return await getTrade(db, 'SELECT * FROM trade WHERE id = ?', id);
}

export async function getLatestTrade(db: Connection) {
    return await getTrade(db, 'SELECT * FROM trade ORDER BY id DESC LIMIT 1');
}

export async function getCandlesticData(
    db: Connection,
    lowerBound: Date,
    timeFormat: string
) {
    const query = `
        SELECT m.t, a.price as open, b.price as close, m.h, m.l, min_id, max_id
        FROM (
            SELECT
                STR_TO_DATE(DATE_FORMAT(created_at, ?), '%Y-%m-%d %H:%i:%s') AS t,
                MIN(id) AS min_id,
                MAX(id) AS max_id,
                MAX(price) AS h,
                MIN(price) AS l
            FROM trade
            WHERE created_at >= ?
            GROUP BY t
        ) m
        JOIN trade a ON a.id = m.min_id
        JOIN trade b ON b.id = m.max_id
        ORDER BY m.t
    `;
    const result = await dbQuery(db, query, [timeFormat, lowerBound]);
    return result.map(
        (row: any) =>
            new CandlestickData(row.t, row.open, row.close, row.h, row.l)
    );
}

export async function hasTradeChanceByOrder(db: Connection, orderId: number) {
    const order = await getOrderById(db, orderId);
    const lowest = await getLowestSellOrder(db);
    if (!lowest) {
        return false;
    }
    const highest = await getHighestBuyOrder(db);
    if (!highest) {
        return false;
    }
    if (order?.type === 'buy' && lowest.price <= order.price) {
        return true;
    }
    if (order?.type === 'sell' && order.price <= highest.price) {
        return true;
    }

    return false;
}

async function reserveOrder(
    db: Connection,
    order: Order,
    price: number
): Promise<number> {
    const bank = await getIsubank(db);
    let p = order.amount * price;
    if (order.type === 'buy') {
        p = -p;
    }
    try {
        return await bank.reserve(order.user!.bank_id, p);
    } catch (e) {
        if (e instanceof CreditInsufficient) {
            await cancelOrder(db, order, 'reserve_failed');
            await sendLog(db, order.type + '.error', {
                error: e.message,
                user_id: order.user_id,
                amount: order.amount,
                price: price,
            });
        }
        throw e;
    }
}

async function commitReservedOrder(
    db: Connection,
    order: Order,
    targets: Order[],
    reserveIds: number[]
) {
    const { insertId } = await dbQuery(
        db,
        'INSERT INTO trade (amount, price, created_at) VALUES (?, ?, NOW(6))',
        [order.amount, order.price]
    );

    const tradeId = insertId;
    sendLog(db, 'trade', {
        trade_id: tradeId,
        price: order.price,
        amount: order.amount,
    });

    const orders = targets.concat([order]);
    await dbQuery(
        db,
        'UPDATE orders SET trade_id = ?, closed_at = NOW(6) WHERE id IN (?)',
        [tradeId, orders.map((order) => order.id)]
    );

    for (const o of orders) {
        if (getLowestSellCache()?.id === o.id) {
            resetLowesetSellCache();
        }
        if (getHighestBuyCache()?.id === o.id) {
            resetHighestBuyCache();
        }
        sendLog(db, o.type + '.trade', {
            order_id: o.id,
            price: order.price,
            amount: o.amount,
            user_id: o.user_id,
            trade_id: tradeId,
        });
    }

    const [trade] = await dbQuery(db, 'SELECT * FROM trade WHERE id = ?', [
        tradeId,
    ]);
    if (!trade || trade.id !== tradeId) {
        console.log('ERROR trade is not found', tradeId);
    }

    const bank = await getIsubank(db);
    await bank.commit(reserveIds);
    addCacheTrade(trade);
}

async function tryTrade(db: Connection, orderId: number) {
    const sw = new StopWatch('tryTrade');
    const order = await getOpenOrderById(db, orderId);
    if (!order) {
        throw new Error('try trade error');
    }
    sw.record('1');
    let restAmount = order.amount;
    const unitPrice = order.price;
    let reserves = [await reserveOrder(db, order, unitPrice)];
    sw.record('2');
    try {
        let result: any[][];
        if (order.type === 'buy') {
            result = await dbQuery(
                db,
                'SELECT * FROM orders WHERE type = ? AND closed_at IS NULL AND price <= ? ORDER BY price ASC, created_at ASC, id ASC LIMIT ? FOR UPDATE',
                ['sell', order.price, order.amount * 10]
            );
        } else {
            result = await dbQuery(
                db,
                'SELECT * FROM orders WHERE type = ? AND closed_at IS NULL AND price >= ? ORDER BY price DESC, created_at DESC, id DESC LIMIT ? FOR UPDATE',
                ['buy', order.price, order.amount * 10]
            );
        }
        sw.record('3');
        const targetOrders = result.map(
            (row: any) =>
                new Order(
                    row.id,
                    row.type,
                    row.user_id,
                    row.amount,
                    row.price,
                    row.closed_at,
                    row.trade_id,
                    row.created_at
                )
        );
        const targets: Order[] = [];
        for (let to of targetOrders) {
            try {
                to = (await getOpenOrderById(db, to.id)) as Order;
                if (!to) continue;
            } catch (e) {
                continue;
            }
            if (to.amount > restAmount) {
                continue;
            }
            try {
                const rid = await reserveOrder(db, to, unitPrice);
                reserves.push(rid);
            } catch (e) {
                continue;
            }
            targets.push(to);
            restAmount -= to.amount;
            if (restAmount === 0) {
                break;
            }
        }
        sw.record('4');
        if (restAmount > 0) {
            throw new NoOrderForTrade();
        }
        try {
            await commitReservedOrder(db, order, targets, reserves);
            sw.record('5');
        } catch (e) {
            console.error('commitReservedOrder error!', e);
            process.exit(1);
        }
        reserves = [];
    } finally {
        if (reserves.length) {
            try {
                const bank = await getIsubank(db);
                sw.record('6');
                await bank.cancel(reserves);
                sw.record('7');
            } catch (e) {
                console.error('Cancel error!', e);
                process.exit(1);
            }
        }
        sw.end();
    }
}

let runningTrade: { [key: string]: boolean } = {};

export async function runTrade(db: Connection) {
    const lowestSellOrder = await getLowestSellOrder(db);
    if (!lowestSellOrder) {
        // 売り注文が無いため成立しない
        return;
    }
    const highestBuyOrder = await getHighestBuyOrder(db);
    if (!highestBuyOrder) {
        // 買い注文が無いため成立しない
        return;
    }
    if (lowestSellOrder.price > highestBuyOrder.price) {
        // 最安の売値が最高の買値よりも高いため成立しない
        return;
    }
    if (runningTrade[`${lowestSellOrder.id}_${highestBuyOrder.id}`]) return;
    runningTrade[`${lowestSellOrder.id}_${highestBuyOrder.id}`] = true;
    let candidates: number[];
    if (lowestSellOrder.amount > highestBuyOrder.amount) {
        candidates = [lowestSellOrder.id, highestBuyOrder.id];
    } else {
        candidates = [highestBuyOrder.id, lowestSellOrder.id];
    }

    for (const orderId of candidates) {
        await promisify(db.beginTransaction.bind(db))();
        try {
            await tryTrade(db, orderId);
            // トレード成立したため次の取引を行う
            await promisify(db.commit.bind(db))();
            await runTrade(db);
        } catch (e) {
            if (
                e instanceof NoOrderForTrade ||
                e instanceof OrderAlreadyClosed
            ) {
                // 注文個数の多い方で成立しなかったので少ない方で試す
                await promisify(db.commit.bind(db))();
                continue;
            } else if (e instanceof CreditInsufficient) {
                await promisify(db.commit.bind(db))();
                runningTrade[
                    `${lowestSellOrder.id}_${highestBuyOrder.id}`
                ] = false;
                throw e;
            } else {
                await promisify(db.rollback.bind(db))();
                runningTrade[
                    `${lowestSellOrder.id}_${highestBuyOrder.id}`
                ] = false;
                throw e;
            }
        }
    }
    runningTrade[`${lowestSellOrder.id}_${highestBuyOrder.id}`] = false;

    // 個数が不足していて不成立
}
