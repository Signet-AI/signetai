import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AssistantChatMessage } from "@signet/core";
import { type AssistantModelOption, streamAssistantChat } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ChatModelPicker } from "@/components/ai-elements/model-picker";
import { Button } from "@/components/ui/button";
import {
	Conversation,
	ConversationContent,
	ConversationEmptyState,
	ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse, MessageCopyAction } from "@/components/ai-elements/message";
import { PromptInput, PromptInputTextarea, PromptInputSubmit } from "@/components/ai-elements/prompt-input";
import { Sources, SourcesContent, SourcesTrigger } from "@/components/ai-elements/sources";
import { LoaderCircleIcon, XIcon, PlusIcon } from "lucide-react";

type ChatMessage = AssistantChatMessage & {
	id: string;
	citations?: Array<{ sourceRef: string; excerpt: string }>;
	actions?: Array<{ id: string; text: string }>;
	model?: string;
};

export interface MemoryChatProps {
	readonly className?: string;
	readonly inactive?: boolean;
	readonly presentation?: "compact" | "sidebar";
	readonly onClose?: () => void;
	readonly onNewChat?: () => void;
	readonly selectedEntityId?: string;
	readonly onFocusEntity?: (entityId: string) => void;
	readonly onRetrieval?: (nodeIds: readonly string[], evidenceRefs: readonly string[]) => void;
	readonly onTurnStart?: () => void;
	readonly onRetrievalClear?: () => void;
	readonly onMemoryChanged?: () => void;
}

export function MemoryChat({
	className,
	inactive,
	presentation,
	onClose,
	onNewChat,
	selectedEntityId,
	onFocusEntity,
	onMemoryChanged,
	onRetrieval,
	onRetrievalClear,
	onTurnStart,
}: MemoryChatProps) {
	const [messages, setMessages] = useState<Array<ChatMessage>>([]);
	const [input, setInput] = useState("");
	const [modelSelection, setModelSelection] = useState<AssistantModelOption>();
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [expanded, setExpanded] = useState(true);
	const abortRef = useRef<AbortController | null>(null);
	const conversationId = useRef(crypto.randomUUID());
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			abortRef.current?.abort();
		};
	}, []);

	const updateLastMessage = (update: (message: ChatMessage) => ChatMessage) => {
		setMessages((current) =>
			current.map((message, index) => (index === current.length - 1 ? update(message) : message)),
		);
	};

	const submit = async () => {
		const content = input.trim();
		if (!content || busy) return;
		const staged: Array<ChatMessage> = [
			...messages.filter((message) => message.content),
			{ id: crypto.randomUUID(), role: "user", content },
		];
		const conversation = staged.map(({ role, content }) => ({ role, content }));
		if (
			conversation.length > 32 ||
			conversation.reduce((total, message) => total + message.content.length, 0) > 64000
		) {
			setError("This conversation has reached its limit. Start a new chat to continue.");
			return;
		}
		const controller = new AbortController();
		abortRef.current = controller;
		setMessages([...staged, { id: crypto.randomUUID(), role: "assistant", content: "" }]);
		setInput("");
		setBusy(true);
		setError(null);
		setStatus("Thinking…");
		onRetrievalClear?.();
		onTurnStart?.();
		setExpanded(true);
		try {
			await streamAssistantChat(
				conversation,
				(event) => {
					if (!mounted.current || controller.signal.aborted) return;
					if (event.type === "delta") {
						setStatus("");
						setMessages((current) =>
							current.map((message, index) =>
								index === current.length - 1 ? { ...message, content: message.content + event.text } : message,
							),
						);
					}
					if (event.type === "tool") setStatus(`${event.name.replaceAll("_", " ")}…`);
					if (event.type === "retrieval") onRetrieval?.(event.nodeIds, event.evidenceRefs);
					if (event.type === "focus") onFocusEntity?.(event.entityId);
					if (event.type === "citation")
						updateLastMessage((message) => ({
							...message,
							citations: message.citations?.some((item) => item.sourceRef === event.sourceRef)
								? message.citations.map((item) =>
										item.sourceRef === event.sourceRef && event.excerpt ? { ...item, excerpt: event.excerpt } : item,
									)
								: [...(message.citations ?? []), { sourceRef: event.sourceRef, excerpt: event.excerpt }].slice(-100),
						}));
					if (event.type === "saved") {
						updateLastMessage((message) => ({
							...message,
							actions: [
								...(message.actions ?? []),
								{ id: crypto.randomUUID(), text: "Your message was saved as evidence." },
							],
						}));
						setStatus("Context saved as evidence");
						onMemoryChanged?.();
					}
					if (event.type === "dream") {
						updateLastMessage((message) => ({
							...message,
							actions: [
								...(message.actions ?? []),
								{ id: event.passId, text: `Dreaming requested (${event.passId}); changes are pending.` },
							],
						}));
						setStatus("Dreaming requested — changes are pending");
					}
					if (event.type === "done") {
						setStatus("");
						updateLastMessage((message) => ({ ...message, model: event.model }));
					}
				},
				controller.signal,
				conversationId.current,
				selectedEntityId,
				modelSelection,
			);
		} catch (cause) {
			if (mounted.current) {
				onRetrievalClear?.();
				setError(
					controller.signal.aborted
						? "Response stopped. Completed saves or Dreaming requests remain in effect."
						: cause instanceof Error
							? cause.message
							: "Assistant unavailable",
				);
				setStatus("");
			}
		} finally {
			if (mounted.current) setBusy(false);
			abortRef.current = null;
		}
	};
	const promptRef = useRef<HTMLFormElement>(null);
	const dockRect = useRef<DOMRect | null>(null);
	useLayoutEffect(() => {
		const prompt = promptRef.current;
		if (!prompt) return;
		if (presentation === "compact") {
			dockRect.current = prompt.getBoundingClientRect();
			return;
		}
		const from = dockRect.current;
		dockRect.current = null;
		if (!from || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		const to = prompt.getBoundingClientRect();
		prompt.animate(
			[
				{ transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)`, width: `${from.width}px` },
				{ transform: "translate(0, 0)", width: `${to.width}px` },
			],
			{ duration: 360, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
		);
	}, [presentation]);
	return (
		<section
			className={cn("memory-chat", presentation === "sidebar" && "memory-chat-sidebar", className)}
			aria-label="Signet chat"
			inert={inactive}
			aria-hidden={inactive || undefined}
		>
			{presentation !== "compact" && (messages.length > 0 || presentation === "sidebar") && (
				<div className="memory-chat-header">
					{presentation === "sidebar" ? (
						<div className="chat-heading">
							<h2>Signet</h2>
							<span>Memory assistant</span>
						</div>
					) : (
						<Button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
							{expanded ? "Hide conversation" : "Show conversation"}
						</Button>
					)}
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						aria-label="New chat"
						title="New chat"
						disabled={busy}
						onClick={() => {
							onRetrievalClear?.();
							setMessages([]);
							conversationId.current = crypto.randomUUID();

							setError(null);
							setStatus("");
							onNewChat?.();
						}}
					>
						<PlusIcon className="size-4" />
					</Button>
					{presentation === "sidebar" && onClose && (
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							className="memory-chat-close"
							aria-label="Close chat"
							onClick={onClose}
						>
							<XIcon className="size-4" />
						</Button>
					)}
				</div>
			)}
			{presentation !== "compact" && expanded && (
				<Conversation className="memory-chat-conversation" aria-label="Conversation">
					<ConversationContent className="memory-chat-content">
						{messages.length === 0 && (
							<ConversationEmptyState
								title="Explore your memories"
								description="Ask a question, connect ideas, or share new context with Signet."
							/>
						)}
						{messages.map((message, index) => {
							const streaming = busy && index === messages.length - 1;
							return (
								<Message key={message.id} from={message.role}>
									<span className={cn("chat-message-label", message.role === "user" && "sr-only")}>
										{message.role === "user" ? "You" : "Signet"}
									</span>
									<MessageContent>
										{message.role === "user" ? (
											<p className="whitespace-pre-wrap break-words">{message.content}</p>
										) : message.content ? (
											<MessageResponse
												isAnimating={streaming}
												citations={messages.flatMap((item) => item.citations ?? [])}
											>
												{message.content}
											</MessageResponse>
										) : (
											<p className="chat-pending">
												{busy ? (
													<>
														<LoaderCircleIcon className="size-3.5 animate-spin" /> {status || "Thinking…"}
													</>
												) : (
													"No response received."
												)}
											</p>
										)}
									</MessageContent>
									{message.citations && message.citations.length > 0 && (
										<Sources>
											<SourcesTrigger count={message.citations.length} />
											<SourcesContent className="chat-evidence">
												{message.citations.map((citation) => (
													<blockquote key={citation.sourceRef}>
														<p>{citation.excerpt}</p>
														<code>{citation.sourceRef}</code>
													</blockquote>
												))}
											</SourcesContent>
										</Sources>
									)}
									{message.actions?.map((action) => (
										<p key={action.id} className="chat-action-result">
											{action.text}
										</p>
									))}
									{message.role === "assistant" && message.content && !streaming && (
										<div className="chat-message-footer">
											<MessageCopyAction content={message.content} />
											{message.model && <span className="chat-message-model">{message.model}</span>}
										</div>
									)}
								</Message>
							);
						})}
					</ConversationContent>
					<ConversationScrollButton />
				</Conversation>
			)}

			{error && (
				<p className="memory-chat-error" role="alert">
					{error}
				</p>
			)}
			{status && presentation !== "compact" && (!busy || messages.at(-1)?.content) && (
				<p className="memory-chat-status" role="status">
					{status}
				</p>
			)}
			<PromptInput
				ref={promptRef}
				onSubmit={(event) => {
					event.preventDefault();
					void submit();
				}}
			>
				<PromptInputTextarea
					aria-label="Ask Signet about your memories"
					placeholder={presentation === "sidebar" ? "Message Signet…" : "Ask Signet about your memories…"}
					value={input}
					onChange={(event) => setInput(event.target.value)}
					maxLength={16000}
					disabled={busy}
				/>
				<div className="chat-prompt-footer">
					<ChatModelPicker selection={modelSelection} onSelect={setModelSelection} disabled={busy} />

					<PromptInputSubmit
						generating={busy}
						disabled={!input.trim()}
						onStop={() => {
							onRetrievalClear?.();
							abortRef.current?.abort();
						}}
					/>
				</div>
			</PromptInput>
		</section>
	);
}
