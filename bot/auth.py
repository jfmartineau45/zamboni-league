"""
auth.py — Bot authentication token management
"""
bot_token = None

def set_token(token: str):
    """Set the admin token after bot authenticates"""
    global bot_token
    bot_token = token

def get_token() -> str:
    """Get the current admin token"""
    return bot_token or ''
