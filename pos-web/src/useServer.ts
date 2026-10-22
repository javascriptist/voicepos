import { useCallback, useEffect, useReducer, useRef } from 'react'

import { initialState, reduce } from './state'
import type { Order, ServerMessage } from './types'

const RETRY_MS = [500, 1000, 2000, 5000]
const TOAST_MS = 4000

function socketUrl(): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${location.host}/ws/pos`
}

/** Live connection to the voice server's POS socket. Reconnects with backoff, and acknowledges
 * every order event once the screen has painted it (the `pos_updated` timing stage). */
export function useServer() {
  const [state, dispatch] = useReducer(reduce, initialState)
  const socket = useRef<WebSocket | null>(null)

  const send = useCallback((message: Record<string, unknown>): boolean => {
    const ws = socket.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    ws.send(JSON.stringify(message))
    return true
  }, [])

  useEffect(() => {
    let attempt = 0
    let toastSeq = 0
    let retry: number | undefined
    let stopped = false

    const connect = () => {
      dispatch({ type: 'connection', connection: 'connecting' })
      const ws = new WebSocket(socketUrl())
      socket.current = ws
      ws.onopen = () => {
        attempt = 0
        dispatch({ type: 'connection', connection: 'open' })
      }
      ws.onmessage = (message: MessageEvent<string>) => {
        const data = JSON.parse(message.data) as ServerMessage
        if (data.type === 'event' || data.type === 'error') {
          const toastId = ++toastSeq
          dispatch({ ...data, toastId })
          window.setTimeout(() => dispatch({ type: 'dismiss', id: toastId }), TOAST_MS)
        } else {
          dispatch(data)
        }
        if (data.type === 'event') {
          // Two frames: the first lets React commit, the second runs after the browser paints.
          requestAnimationFrame(() =>
            requestAnimationFrame(() =>
              send({ type: 'ack', event_id: data.event_id, rendered_at: Date.now() }),
            ),
          )
        }
      }
      ws.onclose = () => {
        socket.current = null
        dispatch({ type: 'connection', connection: 'closed' })
        if (stopped) return
        retry = window.setTimeout(connect, RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)])
      }
    }

    connect()
    return () => {
      stopped = true
      window.clearTimeout(retry)
      socket.current?.close()
    }
  }, [send])

  const sendOrder = useCallback(
    (order: Omit<Order, 'confidence'>, startedAt: number) =>
      send({ type: 'order', order, started_at: startedAt }),
    [send],
  )

  return { state, sendOrder }
}
