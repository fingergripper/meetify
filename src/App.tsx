import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase, supabaseConfigError } from './lib/supabase'
import { Mesh } from './lib/webrtc'
import type { Participant, Signal } from './types'

const ROOM = 'main'
const MAX = 10
const meId = (() => { const key = 'meetify-id'; const old = sessionStorage.getItem(key); if (old) return old; const id = crypto.randomUUID(); sessionStorage.setItem(key, id); return id })()

function VideoTile({ participant, volume, onVolumeChange }: { participant: Participant; volume: number; onVolumeChange: (volume: number) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const [audioBlocked, setAudioBlocked] = useState(false)
  const streamKey = participant.stream?.getTracks().map(track => track.id).join(',') ?? ''
  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = participant.stream ?? null
    const audio = audioRef.current
    if (!audio || participant.local || !participant.stream?.getAudioTracks().length) return
    audio.srcObject = participant.stream
    audio.volume = volume
    void audio.play().then(() => setAudioBlocked(false)).catch(() => setAudioBlocked(true))
  }, [participant.local, participant.stream, streamKey, volume])
  const hasVideo = participant.camera && Boolean(participant.stream?.getVideoTracks().length)
  return <div className={'tile' + (participant.sharing ? ' shared' : '')}>
    {!participant.local && <audio ref={audioRef} autoPlay playsInline />}
    {hasVideo ? <video ref={videoRef} autoPlay playsInline muted /> : <div className="avatar">{participant.name.slice(0, 2).toUpperCase()}</div>}
    <div className="name">{participant.name}{participant.local ? ' (you)' : ''}{participant.muted ? ' · muted' : ''}{participant.sharing ? ' · sharing' : ''}</div>
    {audioBlocked && <button className="audio-activate" onClick={() => { const audio = audioRef.current; if (audio) void audio.play().then(() => setAudioBlocked(false)).catch(() => setAudioBlocked(true)) }}>Click to hear</button>}
    {!participant.local && <label className="peer-volume" title={'Volume for ' + participant.name}><span>Vol</span><input aria-label={'Volume for ' + participant.name} type="range" min="0" max="1" step="0.05" value={volume} onChange={event => onVolumeChange(Number(event.target.value))} /></label>}
  </div>
}

function MicrophoneMeter({ stream, enabled }: { stream: MediaStream; enabled: boolean }) {
  const [level, setLevel] = useState(0)
  useEffect(() => {
    const track = stream.getAudioTracks().find(item => item.enabled && item.readyState === 'live')
    if (!enabled || !track) { setLevel(0); return }
    const context = new AudioContext()
    const analyser = context.createAnalyser()
    analyser.fftSize = 512
    const source = context.createMediaStreamSource(new MediaStream([track]))
    source.connect(analyser)
    void context.resume()
    const samples = new Uint8Array(analyser.fftSize)
    let animation = 0
    let lastUpdate = 0
    const sample = (now: number) => {
      animation = requestAnimationFrame(sample)
      if (now - lastUpdate < 90) return
      lastUpdate = now
      analyser.getByteTimeDomainData(samples)
      let sum = 0
      for (const value of samples) { const normalized = (value - 128) / 128; sum += normalized * normalized }
      setLevel(Math.min(1, Math.sqrt(sum / samples.length) * 4.5))
    }
    animation = requestAnimationFrame(sample)
    return () => { cancelAnimationFrame(animation); source.disconnect(); void context.close() }
  }, [enabled, stream])
  return <div className="mic-meter" role="meter" aria-label="Microphone volume" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}><i style={{ transform: `scaleX(${level})` }} /></div>
}

export function App() {
  const [name, setName] = useState(localStorage.getItem('meetify-name') ?? '')
  const [joined, setJoined] = useState(false); const [participants, setParticipants] = useState<Participant[]>([])
  const [muted, setMuted] = useState(false); const [camera, setCamera] = useState(false); const [sharing, setSharing] = useState(false); const [status, setStatus] = useState('Ready')
  const [volumes, setVolumes] = useState<Record<string, number>>(() => { try { return JSON.parse(localStorage.getItem('meetify-volumes') ?? '{}') as Record<string, number> } catch { return {} } })
  const [error, setError] = useState(''); const streamRef = useRef(new MediaStream()); const screenRef = useRef<MediaStreamTrack | null>(null); const meshRef = useRef<Mesh | null>(null); const channelRef = useRef<ReturnType<NonNullable<typeof supabase>['channel']> | null>(null)
  const send = useCallback((message: Signal) => { channelRef.current?.send({ type: 'broadcast', event: 'signal', payload: message }) }, [])
  const setPeerVolume = (id: string, volume: number) => setVolumes(previous => {
    const next = { ...previous, [id]: volume }
    localStorage.setItem('meetify-volumes', JSON.stringify(next))
    return next
  })

  const join = async () => {
    if (!supabase) { setError(supabaseConfigError ?? 'Supabase is not configured.'); return }
    const cleanName = name.trim().slice(0, 24); if (!cleanName) { setError('Enter a nickname to join.'); return }
    setError(''); localStorage.setItem('meetify-name', cleanName)
    const channel = supabase.channel(`room:${ROOM}`, { config: { presence: { key: meId } } }); channelRef.current = channel
    channel.on('broadcast', { event: 'signal' }, ({ payload }) => { const msg = payload as Signal; if (msg.type === 'join') { meshRef.current?.add(msg.from, streamRef.current, meId.localeCompare(msg.from) < 0); setParticipants(p => p.some(x => x.id === msg.from) ? p : [...p, { id: msg.from, name: 'Guest', muted: false, camera: false, sharing: false }]) } else if (msg.type === 'leave') { meshRef.current?.remove(msg.from); setParticipants(p => p.filter(x => x.id !== msg.from)) } else if (msg.type === 'state' && msg.from !== meId) setParticipants(p => p.map(x => x.id === msg.from ? { ...x, ...(msg.payload as Partial<Participant>) } : x)); else void meshRef.current?.receive(msg, streamRef.current) })
    meshRef.current = new Mesh(meId, { signal: send, stream: (id, stream) => setParticipants(p => p.map(x => x.id === id ? { ...x, stream, camera: stream.getVideoTracks().length > 0 } : x)), state: () => undefined })
    channel.on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState<{ name: string; muted?: boolean; camera?: boolean; sharing?: boolean }>()
      const people = Object.entries(state).flatMap(([id, entries]) => entries.map(entry => ({ id, ...entry }))).filter(person => person.id !== meId)
      if (people.length >= MAX) { setError(`Room full — maximum ${MAX} people.`); setJoined(false); void channel.unsubscribe(); channelRef.current = null; return }
      setParticipants(previous => {
        const oldById = new Map(previous.map(person => [person.id, person]))
        const activeIds = new Set(people.map(person => person.id))
        previous.filter(person => !person.local && !activeIds.has(person.id)).forEach(person => meshRef.current?.remove(person.id))
        return [
          { id: meId, name: cleanName, stream: streamRef.current, muted: streamRef.current.getAudioTracks().every(track => !track.enabled), camera: streamRef.current.getVideoTracks().some(track => track.enabled), sharing: screenRef.current?.readyState === 'live', local: true },
          ...people.map(person => {
            const old = oldById.get(person.id)
            return { id: person.id, name: person.name, stream: old?.stream, muted: person.muted ?? old?.muted ?? true, camera: person.camera ?? old?.camera ?? false, sharing: person.sharing ?? old?.sharing ?? false }
          }),
        ]
      })
      people.forEach(person => meshRef.current?.add(person.id, streamRef.current, meId.localeCompare(person.id) < 0))
    })
    channel.subscribe(async s => {
      if (s === 'SUBSCRIBED') {
        setJoined(true); setStatus('Connected')
        const localMuted = streamRef.current.getAudioTracks().every(track => !track.enabled)
        const localCamera = streamRef.current.getVideoTracks().some(track => track.enabled)
        await channel.track({ name: cleanName, muted: localMuted, camera: localCamera, sharing })
        send({ type: 'join', from: meId })
        send({ type: 'state', from: meId, payload: { muted: localMuted, camera: localCamera, sharing } })
      } else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') { setError('Could not connect to the room. Check the Supabase URL, key, and Realtime settings.'); setJoined(false); void channel.unsubscribe(); channelRef.current = null }
    })
  }
  const startMedia = async (audio: boolean, video: boolean) => {
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        audio: audio ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true } : false,
        video: video ? { width: { ideal: 1280, max: 1920 }, height: { ideal: 720, max: 1080 }, frameRate: { ideal: 30, max: 60 }, aspectRatio: { ideal: 16 / 9 } } : false,
      })
      media.getTracks().forEach(track => streamRef.current.addTrack(track))
      if (audio) setMuted(false)
      if (video) setCamera(true)
      setParticipants(p => p.map(item => item.local ? { ...item, stream: streamRef.current, muted: false, camera: video || item.camera } : item))
      meshRef.current?.updateStream(streamRef.current)
      setStatus(audio && video ? 'Camera and mic ready' : audio ? 'Microphone ready' : 'Camera ready')
      send({ type: 'state', from: meId, payload: { muted: false, ...(video ? { camera: true } : {}) } })
    } catch (reason) {
      const message = reason instanceof DOMException && reason.name === 'NotAllowedError' ? 'Allow camera or microphone access in your browser to use this device.' : 'Camera or microphone unavailable.'
      setError(message)
    }
  }
  const toggleMute = () => { if (!streamRef.current.getAudioTracks().length) { void startMedia(true, false); return } const next = !muted; streamRef.current.getAudioTracks().forEach(t => t.enabled = !next); setMuted(next); setParticipants(p => p.map(x => x.local ? { ...x, muted: next } : x)); send({ type: 'state', from: meId, payload: { muted: next } }) }
  const toggleCamera = () => { if (!streamRef.current.getVideoTracks().length) { void startMedia(false, true); return } const next = !camera; streamRef.current.getVideoTracks().forEach(t => t.enabled = next); setCamera(next); setParticipants(p => p.map(x => x.local ? { ...x, camera: next } : x)); send({ type: 'state', from: meId, payload: { camera: next } }) }
  const share = async () => { if (sharing) { screenRef.current?.stop(); return } try { const display = await navigator.mediaDevices.getDisplayMedia({ video: true }); const track = display.getVideoTracks()[0]; screenRef.current = track; meshRef.current?.replaceVideo(track, display); setSharing(true); setParticipants(p => p.map(x => x.local ? { ...x, sharing: true } : x)); send({ type: 'state', from: meId, payload: { sharing: true } }); track.onended = () => { meshRef.current?.replaceVideo(streamRef.current.getVideoTracks()[0] ?? null); setSharing(false); setParticipants(p => p.map(x => x.local ? { ...x, sharing: false } : x)); send({ type: 'state', from: meId, payload: { sharing: false } }) } } catch { setError('Screen sharing was cancelled.'); } }
  const leave = () => { send({ type: 'leave', from: meId }); meshRef.current?.close(); streamRef.current.getTracks().forEach(t => t.stop()); void channelRef.current?.unsubscribe(); channelRef.current = null; setJoined(false); setParticipants([]); setStatus('Ready'); setCamera(false); setSharing(false); streamRef.current = new MediaStream() }
  useEffect(() => () => { meshRef.current?.close(); streamRef.current.getTracks().forEach(t => t.stop()) }, [])
  if (!joined) return <main className="welcome"><div className="brand">MEETIFY</div><h1>One room. Always open.</h1><p className="sub">A simple, private video room for your friends.</p><label>Nickname<input autoFocus value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && void join()} maxLength={24} placeholder="Your name" /></label><div className="join-row"><button className="primary" onClick={() => void join()}>Join room</button><button onClick={() => void startMedia(true, true)}>Enable camera & mic</button></div>{error && <p className="error">{error}</p>}<p className="hint">Room: /{ROOM} · maximum {MAX} people</p></main>
  return <main className="room"><header><div><span className="brand">MEETIFY</span><span className="room-label"> / {ROOM}</span></div><span className="status"><i />{status}</span></header><section className={'grid ' + (participants.length > 5 ? 'count-many' : 'count-' + participants.length)}>{participants.map(p => <VideoTile key={p.id} participant={p} volume={volumes[p.id] ?? 1} onVolumeChange={volume => setPeerVolume(p.id, volume)} />)}</section>{error && <div className="toast">{error}<button onClick={() => setError('')}>×</button></div>}<footer><button aria-label="Mute microphone" className={muted ? 'active' : ''} onClick={toggleMute}>🎤 <span>{muted ? 'Unmute' : 'Mute'}</span></button><MicrophoneMeter stream={streamRef.current} enabled={!muted && streamRef.current.getAudioTracks().some(track => track.enabled)} /><button aria-label="Toggle camera" className={!camera ? 'active' : ''} onClick={toggleCamera}>📷 <span>{camera ? 'Camera off' : 'Camera on'}</span></button><button aria-label="Share screen" className={sharing ? 'active' : ''} onClick={() => void share()}>▣ <span>{sharing ? 'Stop sharing' : 'Share screen'}</span></button><button aria-label="Leave room" className="leave" onClick={leave}>↪ <span>Leave</span></button></footer></main>
}
