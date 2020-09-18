import { Connection } from 'mysql';
import { dbQuery } from '../db';
import { IsuBank } from '../vendor/isubank';
import { IsuLogger } from '../vendor/isulogger';

const BANK_ENDPOINT = 'bank_endpoint';
const BANK_APPID = 'bank_appid';
const LOG_ENDPOINT = 'log_endpoint';
const LOG_APPID = 'log_appid';

const settingsCache = {} as any;

export async function setSetting(db: Connection, k: string, v: string) {
    settingsCache[k] = v;
    await dbQuery(
        db,
        'INSERT INTO setting (name, val) VALUES (?, ?) ON DUPLICATE KEY UPDATE val = VALUES(val)',
        [k, v]
    );
}

export async function getSetting(db: Connection, k: string): Promise<string> {
    if (settingsCache[k]) return settingsCache[k];
    const [{ val }] = await dbQuery(
        db,
        'SELECT val FROM setting WHERE name = ?',
        [k]
    );
    settingsCache[k] = val;
    return val;
}

const isubank = new IsuBank('', '');
export async function getIsubank(db: Connection): Promise<IsuBank> {
    const endpoint = await getSetting(db, BANK_ENDPOINT);
    const appid = await getSetting(db, BANK_APPID);
    isubank.endpoint = endpoint;
    isubank.appID = appid;
    return isubank;
}

const isulogger = new IsuLogger('', '');
async function getLogger(db: Connection): Promise<IsuLogger> {
    const endpoint = await getSetting(db, LOG_ENDPOINT);
    const appid = await getSetting(db, LOG_APPID);
    isulogger.endpoint = endpoint;
    isulogger.appID = appid;
    return isulogger;
}

export async function sendLog(
    db: Connection,
    tag: string,
    v: {
        error?: string;
        amount?: number;
        price?: number;
        order_id?: number;
        user_id?: number;
        trade_id?: number;
        reason?: string;
        bank_id?: string;
        name?: string;
    }
): Promise<void> {
    const logger = await getLogger(db);
    await logger.send(tag, v);
}
