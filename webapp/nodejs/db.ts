import mysql from 'mysql';
import { promisify } from 'util';

const DB_HOST = process.env.ISU_DB_HOST || '127.0.0.1';
const DB_PORT = process.env.ISU_DB_PORT || '3306';
const DB_USER = process.env.ISU_DB_USER || 'root';
const DB_PASSWORD = process.env.ISU_DB_PASSWORD || '';
const DB_NAME = process.env.ISU_DB_NAME || 'isucoin';

const db = mysql.createConnection({
    host: DB_HOST,
    port: parseInt(DB_PORT),
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    charset: 'utf8mb4',
});

export async function dbQuery(query: string, args: any[] = []): Promise<any> {
    return new Promise((resolve, reject) =>
        db.query(query, args, (err, results) => {
            if (err) {
                return reject(err);
            }
            resolve(results);
        })
    );
}

let lock = false;
const queue: (() => Promise<void>)[] = [];

async function runNextTransaction() {
    if (!queue.length) return;
    if (lock) return;
    lock = true;
    try {
        await queue.shift()!();
    } finally {
        lock = false;
    }
    runNextTransaction();
}

export async function transaction(callback: () => Promise<void>) {
    async function doTransaction() {
        await promisify(db.beginTransaction.bind(db))();
        const id = Math.random();
        console.log('begin transaction ' + id);
        try {
            await callback();
            await promisify(db.commit.bind(db))();
        } catch (e) {
            await promisify(db.rollback.bind(db))();
            throw e;
        } finally {
            console.log('end transaction ' + id);
            runNextTransaction();
        }
    }

    return await new Promise((resolve, reject) => {
        queue.push(async () => {
            try {
                await doTransaction();
                resolve();
            } catch (e) {
                reject(e);
            }
        });
        runNextTransaction();
    });
}

export default db;
