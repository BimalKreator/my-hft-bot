import { Router } from 'express';
import { authenticateToken } from '../middleware/authMiddleware.js';
import { getStats } from '../controllers/statsController.js';

const router = Router();

router.get('/', authenticateToken, getStats);

export default router;
