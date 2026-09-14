use super::process_sse;
use crate::ResponseEvent;
use crate::error::ApiError;
use assert_matches::assert_matches;
use bytes::Bytes;
use codex_client::ByteStream;
use codex_client::TransportError;
use futures::FutureExt;
use futures::StreamExt;
use futures::stream;
use pretty_assertions::assert_eq;
use serde_json::json;
use std::time::Duration;
use tokio::sync::mpsc;

fn failure_frame(code: &str, message: &str) -> Bytes {
    let event = json!({
        "type": "response.failed",
        "response": {
            "id": "failed-response",
            "error": { "code": code, "message": message },
        },
    });
    Bytes::from(format!("data: {event}\n\n"))
}

fn process_without_waiting_for_peer(stream: ByteStream) -> Vec<Result<ResponseEvent, ApiError>> {
    let (tx, mut rx) = mpsc::channel(8);
    // All fixture events are ready now. A terminal failure must finish processing
    // without waiting for either the peer to close or the idle timer to expire.
    process_sse(stream, tx, Duration::from_secs(60), /*telemetry*/ None)
        .now_or_never()
        .expect("response.failed must terminate processing without waiting for the peer");
    let events = std::iter::from_fn(|| rx.try_recv().ok()).collect();
    assert_matches!(rx.try_recv(), Err(mpsc::error::TryRecvError::Disconnected));
    events
}

#[tokio::test]
async fn held_open_failure_preserves_server_error() {
    let stream = stream::iter([Ok(failure_frame("server_error", "original server failure"))])
        .chain(stream::pending());

    let events = process_without_waiting_for_peer(Box::pin(stream));

    assert_matches!(events.as_slice(), [Err(ApiError::Retryable { message, delay })] => {
        assert_eq!((message.as_str(), *delay), ("original server failure", None));
    });
}

#[tokio::test]
async fn held_open_failure_preserves_rate_limit_retry_hint() {
    let message = "Rate limit reached. Please try again in 2s.";
    let stream =
        stream::iter([Ok(failure_frame("rate_limit_exceeded", message))]).chain(stream::pending());

    let events = process_without_waiting_for_peer(Box::pin(stream));

    assert_matches!(events.as_slice(), [Err(ApiError::RateLimitExceeded { message: actual, delay })] => {
        assert_eq!((actual.as_str(), *delay), (message, Some(Duration::from_secs(2))));
    });
}

#[tokio::test]
async fn terminal_failure_keeps_partial_output_and_rejects_later_events() {
    let partial = json!({ "type": "response.output_text.delta", "delta": "partial output" });
    let late = json!({ "type": "response.output_text.delta", "delta": "must not be delivered" });
    let completed = json!({ "type": "response.completed", "response": { "id": "too-late" } });
    let stream = stream::iter([
        Ok(Bytes::from(format!("data: {partial}\n\n"))),
        Ok(failure_frame("server_error", "original server failure")),
        Ok(Bytes::from(format!(
            "data: {late}\n\ndata: {completed}\n\n"
        ))),
    ])
    .chain(stream::pending());

    let events = process_without_waiting_for_peer(Box::pin(stream));

    assert_matches!(events.as_slice(), [
        Ok(ResponseEvent::OutputTextDelta(delta)),
        Err(ApiError::Retryable { message, delay }),
    ] => {
        assert_eq!(
            (delta.as_str(), message.as_str(), *delay),
            ("partial output", "original server failure", None),
        );
    });
}

#[tokio::test]
async fn terminal_failure_is_not_replaced_by_later_transport_error() {
    let stream = stream::iter([
        Ok(failure_frame("server_error", "original server failure")),
        Err(TransportError::Network(
            "later connection reset".to_string(),
        )),
    ])
    .chain(stream::pending());

    let events = process_without_waiting_for_peer(Box::pin(stream));

    assert_matches!(events.as_slice(), [Err(ApiError::Retryable { message, delay })] => {
        assert_eq!((message.as_str(), *delay), ("original server failure", None));
    });
}
