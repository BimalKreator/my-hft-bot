import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

import './config/db.js';
import { startMonitoring } from './services/autoBotService.js';
import authRoutes from './routes/authRoutes.js';
import exchangeRoutes from './routes/exchangeRoutes.js';
import scannerRoutes from './routes/scannerRoutes.js';
import settingsRoutes from './routes/settingsRoutes.js';
import tradeRoutes from './routes/tradeRoutes.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT ?? 3000;

app.use(cors());
app.use(express.json());

// Health Check
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.use('/auth', authRoutes);
app.use('/api/exchange', exchangeRoutes);
app.use('/api/scanner', scannerRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/trade', tradeRoutes);

startMonitoring();

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
