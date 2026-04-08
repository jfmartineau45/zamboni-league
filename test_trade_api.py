#!/usr/bin/env python3
"""
Test script for trade proposal API endpoints
Run after signing in to the portal with a linked manager account
"""
import json

BASE_URL = 'http://localhost:3001'

def test_get_roster():
    """Test GET /api/v2/me/roster"""
    print("\n=== Testing GET /api/v2/me/roster ===")
    
    # This requires a valid session cookie from browser
    # You'll need to copy the session cookie from your browser
    print("⚠️  This endpoint requires authentication")
    print("1. Sign in to http://localhost:3001 in your browser")
    print("2. Open DevTools → Application → Cookies")
    print("3. Copy the 'session' cookie value")
    print("4. Run: curl -H 'Cookie: session=YOUR_SESSION_COOKIE' http://localhost:3001/api/v2/me/roster")
    print("\nExpected response:")
    print({
        'myTeam': 'TOR',
        'roster': [12345, 67890],
        'otherTeams': ['MTL', 'BOS', 'DET'],
        'tradeDeadline': None,
        'deadlinePassed': False,
    })

def test_propose_trade():
    """Test POST /api/v2/me/propose-trade"""
    print("\n=== Testing POST /api/v2/me/propose-trade ===")
    
    payload = {
        'otherTeam': 'MTL',
        'playersSent': [12345],
        'playersReceived': [67890],
        'notes': 'Test trade proposal'
    }
    
    print("⚠️  This endpoint requires authentication")
    print("Payload:", json.dumps(payload, indent=2))
    print("\nTo test manually:")
    print("curl -X POST -H 'Content-Type: application/json' \\")
    print("     -H 'Cookie: session=YOUR_SESSION_COOKIE' \\")
    print(f"     -d '{json.dumps(payload)}' \\")
    print("     http://localhost:3001/api/v2/me/propose-trade")
    print("\nExpected response:")
    print({'ok': True, 'id': 'some-uuid-here'})

def test_pending_queue():
    """Test GET /api/pending (admin endpoint)"""
    print("\n=== Testing GET /api/pending ===")
    print("⚠️  This endpoint requires admin authentication")
    print("After proposing a trade, check the pending queue:")
    print("curl -H 'Authorization: Bearer YOUR_ADMIN_TOKEN' \\")
    print("     http://localhost:3001/api/pending?status=pending")

if __name__ == '__main__':
    print("=" * 60)
    print("TRADE API ENDPOINT TESTS")
    print("=" * 60)
    
    test_get_roster()
    test_propose_trade()
    test_pending_queue()
    
    print("\n" + "=" * 60)
    print("MANUAL TESTING STEPS:")
    print("=" * 60)
    print("1. Sign in to http://localhost:3001 with Discord")
    print("2. Link your account to a manager")
    print("3. Open browser DevTools and copy session cookie")
    print("4. Run the curl commands above")
    print("5. Check /api/pending as admin to see the trade request")
    print("=" * 60)
