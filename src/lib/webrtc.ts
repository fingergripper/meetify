import type { Signal } from '../types'

type PeerEvents = { signal: (message: Signal) => void; stream: (id: string, stream: MediaStream) => void; state: (id: string, state: RTCPeerConnectionState) => void }
const rtcConfig: RTCConfiguration = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }

export class Mesh {
  private peers = new Map<string, RTCPeerConnection>()
  private pendingIce = new Map<string, RTCIceCandidateInit[]>()
  private events: PeerEvents
  constructor(private id: string, events: PeerEvents) { this.events = events }
  add(id: string, stream: MediaStream, initiator: boolean) {
    if (id === this.id || this.peers.has(id)) return
    const pc = new RTCPeerConnection(rtcConfig)
    this.peers.set(id, pc)
    stream.getTracks().forEach(track => {
      const sender = pc.addTrack(track, stream)
      if (track.kind === 'video') void this.setVideoQuality(sender)
    })
    pc.ontrack = event => {
      const source = event.streams[0] ?? new MediaStream([event.track])
      this.events.stream(id, new MediaStream(source.getTracks()))
    }
    pc.onicecandidate = event => { if (event.candidate) this.events.signal({ type: 'ice', from: this.id, to: id, payload: event.candidate.toJSON() }) }
    let makingOffer = false
    let ignoreOffer = false
    const polite = this.id.localeCompare(id) > 0
    pc.onnegotiationneeded = async () => {
      try {
        makingOffer = true
        await pc.setLocalDescription()
        if (pc.localDescription) this.events.signal({ type: 'offer', from: this.id, to: id, payload: pc.localDescription })
      } catch (error) { console.warn('[webrtc] offer failed', id, error) }
      finally { makingOffer = false }
    }
    ;(pc as RTCPeerConnection & { meetifyNegotiation?: { polite: boolean; getMakingOffer: () => boolean; getIgnoreOffer: () => boolean; setIgnoreOffer: (value: boolean) => void } }).meetifyNegotiation = { polite, getMakingOffer: () => makingOffer, getIgnoreOffer: () => ignoreOffer, setIgnoreOffer: value => { ignoreOffer = value } }
    pc.onconnectionstatechange = () => {
      this.events.state(id, pc.connectionState)
      if (['failed', 'closed'].includes(pc.connectionState)) this.remove(id)
    }
    if (initiator && pc.signalingState === 'stable') void pc.onnegotiationneeded?.(new Event('negotiationneeded'))
  }
  async receive(message: Signal, stream: MediaStream) {
    if (!message.to || message.to !== this.id) return
    let pc = this.peers.get(message.from)
    if (!pc) { this.add(message.from, stream, false); pc = this.peers.get(message.from) }
    if (!pc) return
    const negotiation = (pc as RTCPeerConnection & { meetifyNegotiation?: { polite: boolean; getMakingOffer: () => boolean; getIgnoreOffer: () => boolean; setIgnoreOffer: (value: boolean) => void } }).meetifyNegotiation
    if (message.type === 'offer') {
      const collision = Boolean(negotiation?.getMakingOffer() || pc.signalingState !== 'stable')
      const ignore = !negotiation?.polite && collision
      negotiation?.setIgnoreOffer(ignore)
      if (ignore) return
      if (collision) await pc.setLocalDescription({ type: 'rollback' })
      await pc.setRemoteDescription(message.payload as RTCSessionDescriptionInit)
      await this.flushIce(message.from, pc)
      await pc.setLocalDescription()
      if (pc.localDescription) this.events.signal({ type: 'answer', from: this.id, to: message.from, payload: pc.localDescription })
    } else if (message.type === 'answer') {
      await pc.setRemoteDescription(message.payload as RTCSessionDescriptionInit)
      await this.flushIce(message.from, pc)
    } else if (message.type === 'ice') {
      const candidate = message.payload as RTCIceCandidateInit
      if (negotiation?.getIgnoreOffer()) return
      if (!pc.remoteDescription) this.pendingIce.set(message.from, [...(this.pendingIce.get(message.from) ?? []), candidate])
      else { try { await pc.addIceCandidate(candidate) } catch (error) { console.warn('[webrtc] ICE candidate rejected', message.from, error) } }
    }
  }
  replaceVideo(track: MediaStreamTrack | null, stream?: MediaStream) {
    this.peers.forEach(pc => {
      const sender = pc.getSenders().find(s => s.track?.kind === 'video')
      if (sender) void sender.replaceTrack(track)
      else if (track && stream) pc.addTrack(track, stream)
    })
  }
  updateStream(stream: MediaStream) {
    this.peers.forEach(async pc => {
      for (const track of stream.getTracks()) {
        const sender = pc.getSenders().find(s => s.track?.kind === track.kind)
        if (sender) await sender.replaceTrack(track)
        else {
          const nextSender = pc.addTrack(track, stream)
          if (track.kind === 'video') void this.setVideoQuality(nextSender)
        }
      }
    })
  }
  private async flushIce(id: string, pc: RTCPeerConnection) {
    const candidates = this.pendingIce.get(id) ?? []
    this.pendingIce.delete(id)
    for (const candidate of candidates) {
      try { await pc.addIceCandidate(candidate) }
      catch (error) { console.warn('[webrtc] queued ICE candidate rejected', id, error) }
    }
  }
  private async setVideoQuality(sender: RTCRtpSender) {
    try {
      const parameters = sender.getParameters()
      if (!parameters.encodings?.length) parameters.encodings = [{}]
      parameters.encodings[0].maxBitrate = 1_800_000
      parameters.encodings[0].maxFramerate = 30
      await sender.setParameters(parameters)
    } catch (error) { console.warn('[webrtc] video quality settings unavailable', error) }
  }
  remove(id: string) { this.peers.get(id)?.close(); this.peers.delete(id); this.pendingIce.delete(id) }
  close() { this.peers.forEach(pc => pc.close()); this.peers.clear(); this.pendingIce.clear() }
}
