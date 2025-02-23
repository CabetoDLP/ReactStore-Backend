import pkg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pkg;

export const pool = new Pool({
  user: process.env.DB_USER, 
  host: process.env.DB_HOST,
  database: process.env.DB,
  password: process.env.DB_PASS,
  port: 5432,
  ssl: true  //false
  /*
    ssl: {
      rejectUnauthorized: false // This param helps if gets problems with ssl certificates
    }
  */
});

pool
  .connect()
  .then(() => console.log('Conexión exitosa con PostgreSQL'))
  .catch(err => console.error('Error al conectar:', err));

export default pool;
