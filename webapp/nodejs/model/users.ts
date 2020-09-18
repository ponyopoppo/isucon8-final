import log4js from 'log4js';
import bcrypt from 'bcrypt';
import { dbQuery } from '../db';
import { getIsubank, sendLog } from './settings';
import { Connection } from 'mysql';
const logger = log4js.getLogger();

export class BankUserNotFound extends Error {
    constructor() {
        super('bank user not found');
        Object.setPrototypeOf(this, BankUserNotFound.prototype);
    }
}

export class BankUserConflict extends Error {
    constructor() {
        super('bank user conflict');
        Object.setPrototypeOf(this, BankUserConflict.prototype);
    }
}

export class UserNotFound extends Error {
    constructor() {
        super('user not found');
        Object.setPrototypeOf(this, UserNotFound.prototype);
    }
}

export class User {
    constructor(
        public id: number,
        public bank_id: string,
        public name: string,
        public password: string,
        public created_at: Date
    ) {
        this.bank_id = bank_id.toString();
        this.name = name.toString();
        this.password = password.toString();
    }
}

export async function getUserById(
    db: Connection,
    id: number
): Promise<User | null> {
    const [r] = await dbQuery(db, 'SELECT * FROM user WHERE id = ?', [id]);
    if (!r) return null;
    const { id: _id, bank_id, name, password, created_at } = r;
    return new User(_id, bank_id, name, password, created_at);
}

export async function getUserByIdWithLock(db: Connection, id: number) {
    const [r] = await dbQuery(
        db,
        'SELECT * FROM user WHERE id = ? FOR UPDATE',
        [id]
    );
    const { id: _id, bank_id, name, password, created_at } = r;
    return new User(_id, bank_id, name, password, created_at);
}

export async function signup(
    db: Connection,
    name: string,
    bankId: string,
    password: string
) {
    const bank = await getIsubank(db);
    // bank_idの検証
    try {
        await bank.check(bankId, 0);
    } catch (e) {
        logger.error(`failed to check bank_id (${bankId})`);
        throw new BankUserNotFound();
    }
    const hpass = await bcrypt.hash(password, await bcrypt.genSalt());
    let userId: number;
    try {
        const result = await dbQuery(
            db,
            'INSERT INTO user (bank_id, name, password, created_at) VALUES (?, ?, ?, NOW(6))',
            [bankId, name, hpass]
        );
        userId = result.insertId;
    } catch (e) {
        throw new BankUserConflict();
    }
    sendLog(db, 'signup', {
        bank_id: bankId,
        user_id: userId,
        name,
    });
}

export async function login(db: Connection, bankId: string, password: string) {
    const [row] = await dbQuery(db, 'SELECT * FROM user WHERE bank_id = ?', [
        bankId,
    ]);
    if (!row) {
        throw new UserNotFound();
    }

    const { id: _id, bank_id, name, password: _password, created_at } = row;
    const user = new User(_id, bank_id, name, _password, created_at);
    if (!(await bcrypt.compare(password, user.password))) {
        throw new UserNotFound();
    }

    sendLog(db, 'signin', { user_id: user.id });
    return user;
}
