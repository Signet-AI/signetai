use std::env;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::time::Duration;

fn main() {
    let port = env::var("SIGNET_PORT").unwrap_or_else(|_| "3850".to_owned());
    let address = format!("127.0.0.1:{port}");
    let address = match address
        .to_socket_addrs()
        .ok()
        .and_then(|mut addresses| addresses.next())
    {
        Some(address) => address,
        None => std::process::exit(1),
    };

    if !ready(address) {
        std::process::exit(1);
    }
}

fn ready(address: SocketAddr) -> bool {
    let timeout = Duration::from_secs(5);
    let mut stream = match TcpStream::connect_timeout(&address, timeout) {
        Ok(stream) => stream,
        Err(_) => return false,
    };
    if stream.set_read_timeout(Some(timeout)).is_err()
        || stream.set_write_timeout(Some(timeout)).is_err()
    {
        return false;
    }

    let request = b"GET /health/ready HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
    if stream.write_all(request).is_err() {
        return false;
    }

    let mut response = [0_u8; 128];
    let bytes_read = match stream.read(&mut response) {
        Ok(bytes_read) => bytes_read,
        Err(_) => return false,
    };
    let response = String::from_utf8_lossy(&response[..bytes_read]);
    parse_http_status(&response).is_some_and(|status| (200..300).contains(&status))
}

fn parse_http_status(response: &str) -> Option<u16> {
    let mut fields = response.lines().next()?.split_whitespace();
    if !fields.next()?.starts_with("HTTP/") {
        return None;
    }
    fields.next()?.parse::<u16>().ok()
}

#[cfg(test)]
mod tests {
    #[test]
    fn parses_http_status_from_versioned_response() {
        assert_eq!(super::parse_http_status("HTTP/1.1 200 OK\r\n"), Some(200));
        assert_eq!(
            super::parse_http_status("HTTP/1.1 503 Service Unavailable\r\n"),
            Some(503)
        );
    }
}
