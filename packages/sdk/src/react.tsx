/**
 * React components for Signet SDK
 */

import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { SignetSDK } from './index';

// Context
interface SignetContextValue {
  signet: SignetSDK | null;
  connected: boolean;
  connecting: boolean;
  error: Error | null;
  connect: () => Promise<void>;
}

const SignetContext = createContext<SignetContextValue | null>(null);

// Provider
export function SignetProvider({ children }: { children: ReactNode }) {
  const [signet, setSignet] = useState<SignetSDK | null>(null);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const connect = async () => {
    setConnecting(true);
    setError(null);
    
    try {
      const sdk = await SignetSDK.detect();
      if (sdk) {
        setSignet(sdk);
        setConnected(true);
      }
    } catch (err) {
      setError(err as Error);
    } finally {
      setConnecting(false);
    }
  };

  return (
    <SignetContext.Provider value={{ signet, connected, connecting, error, connect }}>
      {children}
    </SignetContext.Provider>
  );
}

// Hook
export function useSignet() {
  const context = useContext(SignetContext);
  if (!context) {
    throw new Error('useSignet must be used within a SignetProvider');
  }
  return context;
}

// Connect Button Component
interface SignetButtonProps {
  onConnect?: (signet: SignetSDK) => void;
  className?: string;
  children?: ReactNode;
}

export function SignetButton({ onConnect, className, children }: SignetButtonProps) {
  const { signet, connected, connecting, connect } = useSignet();

  const handleClick = async () => {
    if (!connected) {
      await connect();
    }
    if (signet && onConnect) {
      onConnect(signet);
    }
  };

  return (
    <button 
      onClick={handleClick}
      disabled={connecting}
      className={className}
    >
      {children || (
        connecting ? 'Connecting...' : 
        connected ? 'Connected to Signet' : 
        'Connect Your Agent'
      )}
    </button>
  );
}
