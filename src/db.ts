import pkg from 'pg';
import dotenv from 'dotenv';

const { Pool } = pkg;

export const pool = new Pool({
  user: 'postgres', //postgres
  host: 'reactstore.postgres.database.azure.com', //localhost
  database: 'postgres', //ReactStore
  password: 'cabeto#1', //strixgale
  port: 5432,
  //ssl: true
  ssl: {
    rejectUnauthorized: false // Este parámetro puede ayudar si hay problemas con el certificado SSL
  }
});

pool
  .connect()
  .then(() => console.log('Conexión exitosa con PostgreSQL'))
  .catch(err => console.error('Error al conectar:', err));

export default pool;
