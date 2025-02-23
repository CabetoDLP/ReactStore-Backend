import cors from 'cors';
import express from 'express';
import usersRoutes from './controllers/usersRoutes';
import http from 'http';
import { Server } from 'socket.io';
import { websocketHandlers } from './websockets/handlers';
import dotenv from 'dotenv';

dotenv.config();

console.log("Charging .env variables");
console.log("PORT:", process.env.PORT);
console.log("DB_HOST:", process.env.DB_HOST);
console.log("DB_USER:", process.env.DB_USER);
console.log("DB:", process.env.DB);
console.log("DB_PASS:", process.env.DB_PASS ? "Successfully loaded" : "Undefined");
console.log("JWT_SECRET:", process.env.JWT_SECRET ? "Successfully loaded" : "Undefined");
console.log("JWT_EXPIRES_IN:", process.env.JWT_EXPIRES_IN);
console.log("CLOUDINARY_CLOUD_NAME:", process.env.CLOUDINARY_CLOUD_NAME);
console.log("CLOUDINARY_API_KEY:", process.env.CLOUDINARY_API_KEY);
console.log("CLOUDINARY_API_SECRET:", process.env.CLOUDINARY_API_SECRET ? "Successfully loaded" : "Undefined");
console.log("USER_FOLDER:", process.env.USER_FOLDER);
console.log("PRODUCT_FOLDER:", process.env.PRODUCT_FOLDER);
console.log("MAX_FILE_SIZE:", process.env.MAX_FILE_SIZE);
console.log("COOKIE_MAX_AGE:", process.env.COOKIE_MAX_AGE);
console.log("CORS_ORIGIN:", process.env.CORS_ORIGIN);
console.log("CORS_METHODS:", process.env.CORS_METHODS);
console.log("NODE_ENV:", process.env.NODE_ENV);

const app = express();
const httpServer = http.createServer(app); // creates a HTTP server
const io = new Server(httpServer, {
  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
    methods: process.env.CORS_METHODS?.split(',') || ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true,
  },
});

// Opciones de CORS
export const corsOptions = {
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  methods: process.env.CORS_METHODS?.split(',') as string[] || ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'Accept',
    'Origin',
  ],
  exposedHeaders: ['Authorization', 'Set-Cookie'],
  credentials: true,
  optionsSuccessStatus: 204,
  preflightContinue: false,
};

// Middlewares
app.use(cors(corsOptions));
app.use(express.json());
app.use(usersRoutes);

// Ruta principal
app.get('/', (req, res) => {
  res.send('Welcome to ReactStore marketplace');
});

app.get('/test-env', (req, res) => {
  res.json({ CORS_ORIGIN: process.env.CORS_ORIGIN });
});

// Manejo de errores
app.use((req, res) => {
  res.status(404).send('Route not found');
});

websocketHandlers(io);

// Iniciar el servidor
const PORT = (process.env.PORT || 5000);

httpServer.listen(PORT, () => {
  console.log(`Server running in http://localhost:${PORT}`);
});