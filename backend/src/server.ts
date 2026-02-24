import dns from 'dns';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dns.setDefaultResultOrder('ipv4first');

import './config/db.js';
import { initSettingsTable, initTradeHistoryTable, initClosedTradesExchangeColumn, initDailySnapshotsBinanceColumn } from './models/settingsModel.js';
import { initBotLogsTable, deleteOldLogs } from './models/logModel.js';
import { startMonitoring } from './services/autoBotService.js';
import { startDailySnapshotCron } from './services/cronService.js';
import { fetchBinanceFundingInfo } from './services/binanceService.js';
import { startPositionStreamForOrphanExit } from './services/wsService.js';
import authRoutes from './routes/authRoutes.js';
import banRoutes from './routes/banRoutes.js';
import dashboardRoutes from './routes/dashboardRoutes.js';
import exchangeRoutes from './routes/exchangeRoutes.js';
import scannerRoutes from './routes/scannerRoutes.js';
import settingsRoutes from './routes/settingsRoutes.js';
import statsRoutes from './routes/statsRoutes.js';
import positionRoutes from './routes/positionRoutes.js';
import tradeRoutes from './routes/tradeRoutes.js';
import transactionRoutes from './routes/transactionRoutes.js';
import logRoutes from './routes/logRoutes.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT ?? 3000;

app.use(cors());
app.use(express.json());

// Health Check
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.use('/auth', authRoutes);
app.use('/api/ban', banRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/exchange', exchangeRoutes);
app.use('/api/scanner', scannerRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/positions', positionRoutes);
app.use('/api/trade', tradeRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/logs', logRoutes);

startMonitoring();
startDailySnapshotCron();

initSettingsTable()
  .then(() => initTradeHistoryTable())
  .then(() => initClosedTradesExchangeColumn())
  .then(() => initDailySnapshotsBinanceColumn())
  .then(() => initBotLogsTable())
  .then(() => fetchBinanceFundingInfo())
  .then(() => startPositionStreamForOrphanExit())
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
      setInterval(() => {
        deleteOldLogs()
          .then((n) => n > 0 && console.log(`[logs] Deleted ${n} old bot_logs entries.`))
          .catch((e) => console.warn('[logs] deleteOldLogs failed:', e instanceof Error ? e.message : e));
      }, 60 * 60 * 1000);
    });
  })
  .catch((e) => {
    console.error('Server startup failed:', e);
    process.exit(1);
  });
