import Foundation
import CryptoKit

// BASS BLOCK Native Swift Backend (stdio JSON-RPC).
// Compiled automatically by BASS BLOCK with: swiftc -O backend/main.swift -o .bin/server

func handle(method: String, params: [String: Any]) throws -> Any {
    switch method {
    case "info":
        let proc = ProcessInfo.processInfo
        return [
            "os": proc.operatingSystemVersionString,
            "cores": proc.activeProcessorCount,
            "memoryGb": Double(proc.physicalMemory) / (1024 * 1024 * 1024),
        ]

    case "compute":
        let text = (params["text"] as? String) ?? ""
        let limit = min(max((params["limit"] as? Int) ?? 50000, 100), 2_000_000)
        let t0 = DispatchTime.now().uptimeNanoseconds

        // Fast native prime sieve up to `limit`
        var isPrime = [Bool](repeating: true, count: limit + 1)
        isPrime[0] = false
        if limit >= 1 { isPrime[1] = false }
        var p = 2
        while p * p <= limit {
            if isPrime[p] {
                var i = p * p
                while i <= limit {
                    isPrime[i] = false
                    i += p
                }
            }
            p += 1
        }
        var primeCount = 0
        var lastPrime = 2
        for i in 2...limit where isPrime[i] {
            primeCount += 1
            lastPrime = i
        }

        // Native CryptoKit SHA-256
        let digest = SHA256.hash(data: Data(text.utf8))
        let sha256 = digest.map { String(format: "%02x", $0) }.joined()
        let elapsedMs = Double(DispatchTime.now().uptimeNanoseconds - t0) / 1_000_000.0

        return [
            "limit": limit,
            "primeCount": primeCount,
            "lastPrime": lastPrime,
            "sha256": sha256,
            "byteLength": text.utf8.count,
            "elapsedMs": round(elapsedMs * 1000) / 1000,
        ]

    default:
        throw NSError(domain: "BassBlockSwift", code: 1, userInfo: [NSLocalizedDescriptionKey: "Unknown method: \(method)"])
    }
}

while let line = readLine() {
    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { continue }
    var reqId: Any = NSNull()
    do {
        guard let data = trimmed.data(using: .utf8),
              let req = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            continue
        }
        reqId = req["id"] ?? NSNull()
        let method = (req["method"] as? String) ?? ""
        let params = (req["params"] as? [String: Any]) ?? [:]
        let result = try handle(method: method, params: params)
        let out = try JSONSerialization.data(withJSONObject: ["id": reqId, "result": result])
        if let str = String(data: out, encoding: .utf8) {
            print(str)
            fflush(stdout)
        }
    } catch {
        let errObj: [String: Any] = ["id": reqId, "error": error.localizedDescription]
        if let out = try? JSONSerialization.data(withJSONObject: errObj),
           let str = String(data: out, encoding: .utf8) {
            print(str)
            fflush(stdout)
        }
    }
}
