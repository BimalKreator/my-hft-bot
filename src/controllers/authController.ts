import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { query } from '../config/db.js';

const JWT_SECRET = process.env.JWT_SECRET ?? 'change-me-in-production';
const SALT_ROUNDS = 10;

export async function signup(req: Request, res: Response): Promise<void> {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }
    const hashed = await bcrypt.hash(password, SALT_ROUNDS);
    await query(
      'INSERT INTO users (email, password) VALUES ($1, $2)',
      [email, hashed]
    );
    const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, email });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Signup failed';
    if (msg.includes('unique') || msg.includes('duplicate')) {
      res.status(409).json({ error: 'Email already registered' });
      return;
    }
    res.status(500).json({ error: msg });
  }
}

export async function login(req: Request, res: Response): Promise<void> {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }
    const result = await query<{ id: number; password: string }>(
      'SELECT id, password FROM users WHERE email = $1',
      [email]
    );
    const row = result.rows[0];
    if (!row) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }
    const valid = await bcrypt.compare(password, row.password);
    if (!valid) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }
    const token = jwt.sign({ email, userId: row.id }, JWT_SECRET, {
      expiresIn: '7d',
    });
    res.json({ token, email });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Login failed';
    res.status(500).json({ error: msg });
  }
}
