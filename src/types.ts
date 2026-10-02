export type Signal = { type: 'join' | 'leave' | 'offer' | 'answer' | 'ice' | 'state'; from: string; to?: string; payload?: unknown }
export type Participant = { id: string; name: string; stream?: MediaStream; muted: boolean; camera: boolean; sharing: boolean; local?: boolean }
