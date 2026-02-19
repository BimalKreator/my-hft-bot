import { Router } from 'express';
import { authenticateToken } from '../middleware/authMiddleware.js';
import { getFundingOpportunities } from '../controllers/scannerController.js';

const router = Router();

router.get('/opportunities', authenticateToken, getFundingOpportunities);

export default router;
