import snapshot from 'snap-shot-it';
import { overwrite, overwriteCallback } from './overwrite';
import mysql from 'mysql';
overwrite(mysql, 'createPool', (pool) => {
    overwriteCallback(pool, 'getConnection', (err, connection) => {
        overwrite(connection, 'query', (_, query, args) => {
            // timeline.push('query', query);
            // console.log('query', query, args);
        });
        return [err, connection];
    });
});

let timeline: any[] = [];

export function testOverwrites() {
    beforeEach(() => {
        timeline = [];
    });
    afterEach(() => {
        snapshot(timeline);
    });
}
