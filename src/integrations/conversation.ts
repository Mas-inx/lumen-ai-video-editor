/**
 * Which Copilot chat is open. The chat sets it; tools that work on a chat's own
 * things (its attached files) read it, without the tools depending on the chat UI.
 */
let current = ''

export const setConversation = (id: string) => void (current = id)
export const conversation = () => current
