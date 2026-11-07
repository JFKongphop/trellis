import { Conversation } from "@/components/conversation";

export default function Home() {
  // Cinematic chrome (bg + header) lives in app/layout.tsx and persists
  // across routes. This page just renders the conversation, which sets
  // its own cinematic mode (bright when idle, dim when chatting).
  return (
    <main className="flex min-h-screen flex-col">
      <Conversation />
    </main>
  );
}
