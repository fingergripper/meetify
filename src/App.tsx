import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from './lib/supabase'
import { Mesh } from './lib/webrtc'
import type { Participant, Signal } from './types'

const ROOM = 'main'
const MAX = 10
const meId = (() => { const key = 'meetify-id'; const old = sessionStorage.getItem(key); if (old) return old; const id = crypto.randomUUID(); sessionStorage.setItem(key, id); return id })()

function VideoTile({ participant }: { participant: Participant }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => { if (ref.current && participant.stream) ref.current.srcObject = participant.stream }, [participant.stream])
  return <div className={'tile' + (participant.sharing ? ' shared' : '')}>
    {participant.stream && participant.camera ? <video ref={ref} autoPlay playsInline muted={participant.local} /> : <div className="avatar">{participant.name.slice(0, 2).toUpperCase()}</div>}
    <div className="name">{participant.name}{participant.local ? ' (you)' : ''}{participant.muted ? ' · muted' : ''}{participant.sharing ? ' · sharing' : ''}</div>
  </div>
}

export function App() {
  const [name, setName] = useState(localStorage.getItem('meetify-name') ?? '')
  const [joined, setJoined] = useState(false); const [participants, setParticipants] = useState<Participant[]>([])
  const [muted, setMuted] = useState(false); const [camera, setCamera] = useState(false); const [sharing, setSharing] = useState(false); const [status, setStatus] = useState('Ready')
  const [error, setError] = useState(''); const streamRef = useRef(new MediaStream()); const screenRef = useRef<MediaStreamTrack | null>(null); const meshRef = useRef<Mesh | null>(null); const channelRef = useRef<ReturnType<NonNullable<typeof supabase>['channel']> | null>(null)
  const send = useCallback((message: Signal) => { channelRef.current?.send({ type: 'broadcast', event: 'signal', payload: message }) }, [])

  const join = async () => {
    if (!supabase) { setError('Add your Supabase settings to .env.local first.'); return }
    const cleanName = name.trim().slice(0, 24); if (!cleanName) { setError('Enter a nickname to join.'); return }
    setError(''); localStorage.setItem('meetify-name', cleanName)
    const channel = supabase.channel(`room:${ROOM}`, { config: { presence: { key: meId } } }); channelRef.current = channel
    channel.on('broadcast', { event: 'signal' }, ({ payload }) => { const msg = payload as Signal; if (msg.type === 'join') { meshRef.current?.add(msg.from, streamRef.current, meId.localeCompare(msg.from) < 0); setParticipants(p => p.some(x => x.id === msg.from) ? p : [...p, { id: msg.from, name: 'Guest', muted: false, camera: false, sharing: false }]) } else if (msg.type === 'leave') { meshRef.current?.remove(msg.from); setParticipants(p => p.filter(x => x.id !== msg.from)) } else if (msg.type === 'state' && msg.from !== meId) setParticipants(p => p.map(x => x.id === msg.from ? { ...x, ...(msg.payload as Partial<Participant>) } : x)); else void meshRef.current?.receive(msg, streamRef.current) })
    meshRef.current = new Mesh(meId, { signal: send, stream: (id, stream) => setParticipants(p => p.map(x => x.id === id ? { ...x, stream, camera: stream.getVideoTracks().length > 0 } : x)), state: () => undefined })
    channel.on('presence', { event: 'sync' }, () => { const state = channel.presenceState<{ name: string }>(); const people = Object.entries(state).flatMap(([id, entries]) => entries.map(e => ({ id, name: e.name }))).filter(p => p.id !== meId); if (people.length >= MAX) { setError('Room full — maximum 5 people.'); setJoined(false); void channel.unsubscribe(); channelRef.current = null; return } setParticipants([{ id: meId, name: cleanName, stream: streamRef.current, muted, camera: streamRef.current.getVideoTracks().length > 0, sharing, local: true }, ...people.map(p => ({ ...p, muted: false, camera: false, sharing: false }))]); people.forEach(p => meshRef.current?.add(p.id, streamRef.current, meId.localeCompare(p.id) < 0)) })
    channel.subscribe(async s => { if (s === 'SUBSCRIBED') { setJoined(true); setStatus('Connected'); await channel.track({ name: cleanName }); send({ type: 'join', from: meId }) } else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') { setError('Could not connect to the room. Check the Supabase URL, key, and Realtime settings.'); setJoined(false); void channel.unsubscribe(); channelRef.current = null } })
  }
  const getMedia = async () => { try { const media = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true }, video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 20, max: 30 } } }); media.getTracks().forEach(t => streamRef.current.addTrack(t)); setCamera(true); setParticipants(p => p.map(x => x.local ? { ...x, stream: streamRef.current, camera: true } : x)); meshRef.current?.updateStream(streamRef.current); setStatus('Camera and mic ready') } catch { setError('Camera or microphone unavailable. You can still join without them.'); } }
  const toggleMute = () => { if (!streamRef.current.getAudioTracks().length) { void getMedia(); return } const next = !muted; streamRef.current.getAudioTracks().forEach(t => t.enabled = !next); setMuted(next); setParticipants(p => p.map(x => x.local ? { ...x, muted: next } : x)); send({ type: 'state', from: meId, payload: { muted: next } }) }
  const toggleCamera = () => { if (!streamRef.current.getVideoTracks().length) { void getMedia(); return } const next = !camera; streamRef.current.getVideoTracks().forEach(t => t.enabled = next); setCamera(next); setParticipants(p => p.map(x => x.local ? { ...x, camera: next } : x)); send({ type: 'state', from: meId, payload: { camera: next } }) }
  const share = async () => { if (sharing) { screenRef.current?.stop(); return } try { const display = await navigator.mediaDevices.getDisplayMedia({ video: true }); const track = display.getVideoTracks()[0]; screenRef.current = track; meshRef.current?.replaceVideo(track, display); setSharing(true); setParticipants(p => p.map(x => x.local ? { ...x, sharing: true } : x)); send({ type: 'state', from: meId, payload: { sharing: true } }); track.onended = () => { meshRef.current?.replaceVideo(streamRef.current.getVideoTracks()[0] ?? null); setSharing(false); setParticipants(p => p.map(x => x.local ? { ...x, sharing: false } : x)); send({ type: 'state', from: meId, payload: { sharing: false } }) } } catch { setError('Screen sharing was cancelled.'); } }
  const leave = () => { send({ type: 'leave', from: meId }); meshRef.current?.close(); streamRef.current.getTracks().forEach(t => t.stop()); void channelRef.current?.unsubscribe(); channelRef.current = null; setJoined(false); setParticipants([]); setStatus('Ready'); setCamera(false); setSharing(false); streamRef.current = new MediaStream() }
  useEffect(() => () => { meshRef.current?.close(); streamRef.current.getTracks().forEach(t => t.stop()) }, [])
  if (!joined) return <main className="welcome"><div className="brand">MEETIFY</div><h1>One room. Always open.</h1><p className="sub">A simple, private video room for your friends.</p><label>Nickname<input autoFocus value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && void join()} maxLength={24} placeholder="Your name" /></label><div className="join-row"><button className="primary" onClick={() => void join()}>Join room</button><button onClick={() => void getMedia()}>Enable camera & mic</button></div>{error && <p className="error">{error}</p>}<p className="hint">Room: /{ROOM} · maximum {MAX} people</p></main>
  return <main className="room"><header><div><span className="brand">MEETIFY</span><span className="room-label"> / {ROOM}</span></div><span className="status"><i />{status}</span></header><section className={'grid count-' + participants.length}>{participants.map(p => <VideoTile key={p.id} participant={p} />)}</section>{error && <div className="toast">{error}<button onClick={() => setError('')}>×</button></div>}<footer><button aria-label="Mute microphone" className={muted ? 'active' : ''} onClick={toggleMute}>🎤 <span>{muted ? 'Unmute' : 'Mute'}</span></button><button aria-label="Toggle camera" className={!camera ? 'active' : ''} onClick={toggleCamera}>📷 <span>{camera ? 'Camera off' : 'Camera on'}</span></button><button aria-label="Share screen" className={sharing ? 'active' : ''} onClick={() => void share()}>▣ <span>{sharing ? 'Stop sharing' : 'Share screen'}</span></button><button aria-label="Leave room" className="leave" onClick={leave}>↪ <span>Leave</span></button></footer></main>
}
