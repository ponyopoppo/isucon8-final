import { Connection } from 'mysql';
import { dbQuery } from '../db';
import { getIsubank, sendLog } from './settings';
import { getTradeById, Trade } from './trades';
import { getUserById, getUserByIdWithLock, User } from './users';

export class OrderAlreadyClosed extends Error {
    constructor() {
        super('order is already closed');
        Object.setPrototypeOf(this, OrderAlreadyClosed.prototype);
    }
}

class OrderNotFound extends Error {
    constructor() {
        super('order not found');
        Object.setPrototypeOf(this, OrderNotFound.prototype);
    }
}

export class CreditInsufficient extends Error {
    constructor() {
        super('銀行の残高が足りません');
        Object.setPrototypeOf(this, CreditInsufficient.prototype);
    }
}

export class Order {
    public user?: User | null;
    public trade?: Trade | null;
    constructor(
        public id: number,
        public type: string,
        public user_id: number,
        public amount: number,
        public price: number,
        public closed_at: Date | null,
        public trade_id: number | null,
        public created_at: Date
    ) {
        this.type = type.toString();
    }
}

export async function getOrdersByUserId(
    db: Connection,
    userId: number
): Promise<Order[]> {
    const result = await dbQuery(
        db,
        `SELECT * FROM orders WHERE user_id = ? AND (closed_at IS NULL OR trade_id IS NOT NULL) ORDER BY created_at ASC`,
        [userId]
    );
    return result.map(
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
}

export async function getOrdersByUserIdAndLasttradeid(
    db: Connection,
    userId: number,
    tradeId: number
): Promise<Order[]> {
    const result = await dbQuery(
        db,
        'SELECT * FROM orders WHERE user_id = ? AND trade_id IS NOT NULL AND trade_id > ? ORDER BY created_at ASC',
        [userId, tradeId]
    );
    return result.map(
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
}

async function getOneOrder(
    db: Connection,
    query: string,
    ...args: any[]
): Promise<Order | null> {
    const [result] = await dbQuery(db, query, args);
    if (!result) return null;
    return new Order(
        result.id,
        result.type,
        result.user_id,
        result.amount,
        result.price,
        result.closed_at,
        result.trade_id,
        result.created_at
    );
}

export async function getOrderById(
    db: Connection,
    id: number
): Promise<Order | null> {
    return getOneOrder(db, 'SELECT * FROM orders WHERE id = ?', id);
}

async function getOrderByIdWithLock(
    db: Connection,
    id: number
): Promise<Order | null> {
    const order = await getOneOrder(
        db,
        'SELECT * FROM orders WHERE id = ? FOR UPDATE',
        id
    );
    if (!order) return null;
    order.user = await getUserByIdWithLock(db, order.user_id);
    return order;
}

export async function getOpenOrderById(
    db: Connection,
    id: number
): Promise<Order | null> {
    const order = await getOrderByIdWithLock(db, id);
    if (order?.closed_at) {
        throw new OrderAlreadyClosed();
    }
    return order;
}

export async function getLowestSellOrder(
    db: Connection
): Promise<Order | null> {
    return getOneOrder(
        db,
        'SELECT * FROM orders WHERE type = ? AND closed_at IS NULL ORDER BY price ASC, created_at ASC LIMIT 1',
        'sell'
    );
}

export async function getHighestBuyOrder(
    db: Connection
): Promise<Order | null> {
    return getOneOrder(
        db,
        'SELECT * FROM orders WHERE type = ? AND closed_at IS NULL ORDER BY price DESC, created_at ASC LIMIT 1',
        'buy'
    );
}

export async function fetchOrderRelation(
    db: Connection,
    order: Order
): Promise<void> {
    order.user = await getUserById(db, order.user_id);
    if (order.trade_id) {
        order.trade = await getTradeById(db, order.trade_id);
        if (!order.trade) {
            console.error(
                'No trade!!',
                order.user_id,
                order.trade_id,
                order.id
            );
        }
    }
}

export async function addOrder(
    db: Connection,
    ot: string,
    userId: number,
    amount: number,
    price: number
): Promise<Order> {
    if (amount <= 0 || price <= 0) {
        throw new Error('value error');
    }
    const user = await getUserById(db, userId);
    const bank = await getIsubank(db);
    if (ot === 'buy') {
        const total = price * amount;
        try {
            await bank.check(user!.bank_id, total);
        } catch (e) {
            await sendLog(db, 'buy.error', {
                error: e.message,
                user_id: userId,
                amount: amount,
                price: price,
            });
            throw new CreditInsufficient();
        }
    } else if (ot !== 'sell') {
        throw new Error('value error');
    }
    const createdAt = new Date();
    const { insertId } = await dbQuery(
        db,
        'INSERT INTO orders (type, user_id, amount, price, created_at) VALUES (?, ?, ?, ?, ?)',
        [ot, userId, amount, price, createdAt]
    );
    await sendLog(db, ot + '.order', {
        order_id: insertId,
        user_id: userId,
        amount: amount,
        price: price,
    });
    return new Order(
        insertId,
        ot,
        userId,
        amount,
        price,
        null,
        null,
        createdAt
    );
}

export async function deleteOrder(
    db: Connection,
    userId: number,
    orderId: number,
    reason: string
): Promise<void> {
    const order = await getOrderByIdWithLock(db, orderId);
    const user = await getUserByIdWithLock(db, userId);
    if (!order) {
        throw new OrderNotFound();
    }
    if (order.user_id !== user.id) {
        throw new OrderNotFound();
    }
    if (order.closed_at) {
        throw new OrderAlreadyClosed();
    }

    return cancelOrder(db, order, reason);
}

export async function cancelOrder(
    db: Connection,
    order: Order,
    reason: string
): Promise<void> {
    const order_ = await getOrderByIdWithLock(db, order.id);
    if (order_?.closed_at) {
        throw new OrderAlreadyClosed();
    }
    await dbQuery(db, 'UPDATE orders SET closed_at = NOW(6) WHERE id = ?', [
        order.id,
    ]);
    await sendLog(db, order.type + '.delete', {
        order_id: order.id,
        user_id: order.user_id,
        reason: reason,
    });
}
