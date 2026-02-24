import { Router } from 'express';
import { authenticateToken } from '../middleware/authMiddleware.js';
import { getLogsHandler } from '../controllers/logController.js';

const router = Router();

router.get('/', authenticateToken, getLogsHandler);

export default router;
