#!/bin/bash

DB_DIR=$(cd $(dirname $0); pwd)
export MYSQL_PWD=${ISU_DB_PASSWORD}

mysql -u${ISU_DB_USER} -h${ISU_DB_HOST} -P${ISU_DB_PORT} -p${ISU_DB_PASSWORD} -e "DROP DATABASE IF EXISTS ${ISU_DB_NAME};"
mysql -u${ISU_DB_USER} -h${ISU_DB_HOST} -P${ISU_DB_PORT} -p${ISU_DB_PASSWORD} < "${DB_DIR}/00_create_isucoin_database.sql"
mysql -u${ISU_DB_USER} -h${ISU_DB_HOST} -P${ISU_DB_PORT} -p${ISU_DB_PASSWORD} ${ISU_DB_NAME} < "${DB_DIR}/isucoin.sql"
gzip -dc "$DB_DIR/initializedata.sql.gz" | mysql -u${ISU_DB_USER} -h${ISU_DB_HOST} -P${ISU_DB_PORT} -p${ISU_DB_PASSWORD} ${ISU_DB_NAME}
