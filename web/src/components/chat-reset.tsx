"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
} from "react";

type ResetFn = () => void;

type Ctx = {
  /** Register a reset handler; returns an unregister cleanup. */
  register: (fn: ResetFn) => () => void;
  /** Reset every mounted chat (clears history → hero). */
  resetChat: () => void;
};

const ChatResetContext = createContext<Ctx>({
  register: () => () => {},
  resetChat: () => {},
});

/**
 * Lets the global Trellis logo wipe chat history from outside the chat tree.
 * Multiple <Conversation> instances can be mounted at once (home, plus the
 * feed's desktop rail + always-mounted mobile sheet), so we keep a Set of
 * reset handlers rather than a single slot and fire them all on click.
 */
export function ChatResetProvider({ children }: { children: React.ReactNode }) {
  const fns = useRef<Set<ResetFn>>(new Set());

  const register = useCallback((fn: ResetFn) => {
    fns.current.add(fn);
    return () => {
      fns.current.delete(fn);
    };
  }, []);

  const resetChat = useCallback(() => {
    for (const fn of fns.current) fn();
  }, []);

  return (
    <ChatResetContext.Provider value={{ register, resetChat }}>
      {children}
    </ChatResetContext.Provider>
  );
}

/** Trigger for the logo: clears all mounted chats back to the hero. */
export function useChatReset() {
  return useContext(ChatResetContext).resetChat;
}

/** A <Conversation> registers how to wipe its own session. */
export function useRegisterChatReset(fn: ResetFn) {
  const { register } = useContext(ChatResetContext);
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });
  useEffect(() => register(() => fnRef.current()), [register]);
}
