import { useState, useCallback } from 'react';

const TOKEN_KEY = 'hft_token';
const EMAIL_KEY = 'hft_email';

export function useAuth() {
  const [token, setTokenState] = useState<string | null>(() =>
    typeof window !== 'undefined' ? localStorage.getItem(TOKEN_KEY) : null
  );
  const [email, setEmailState] = useState<string | null>(() =>
    typeof window !== 'undefined' ? localStorage.getItem(EMAIL_KEY) : null
  );

  const setAuth = useCallback((newToken: string, newEmail: string) => {
    localStorage.setItem(TOKEN_KEY, newToken);
    localStorage.setItem(EMAIL_KEY, newEmail);
    setTokenState(newToken);
    setEmailState(newEmail);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(EMAIL_KEY);
    setTokenState(null);
    setEmailState(null);
  }, []);

  return { token, email, setAuth, logout };
}
