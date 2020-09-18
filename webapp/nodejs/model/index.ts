import { Connection } from 'mysql';
import { dbQuery } from '../db';

export async function initBenchmark(db: Connection) {
    await dbQuery(
        db,
        `DELETE FROM orders WHERE created_at >= '2018-10-16 10:00:00'`
    );
    await dbQuery(
        db,
        `DELETE FROM trade  WHERE created_at >= '2018-10-16 10:00:00'`
    );
    await dbQuery(
        db,
        `DELETE FROM user   WHERE created_at >= '2018-10-16 10:00:00'`
    );
}
