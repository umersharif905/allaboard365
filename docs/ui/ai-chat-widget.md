// File: src/components/ai/ChatWidget.jsx
// Description: AI-powered chat widget that floats on all pages to answer questions
// about Open-Enroll features, pricing, and insurance best practices

import React, { useState, useRef, useEffect } from 'react';
import { MessageSquare, X, Send, Minimize2, Maximize2 } from 'lucide-react';

const ChatWidget = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [message, setMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [conversationHistory, setConversationHistory] = useState([]);
  const [messages, setMessages] = useState([
    {
      type: 'bot',
      text: "Hi! I'm your Open-Enroll assistant. How can I help you today?",
      timestamp: new Date()
    }
  ]);
  const messagesEndRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const callAIAPI = async (question) => {
    try {
      const response = await fetch('https://oe-ai-helper-dth9buefenare8a9.eastus2-01.azurewebsites.net/api/ai/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          SystemArea: "Website",
          Prompt: "You are a subject matter expert for Open-Enroll, Respond clearly with properly structured sentences",
          Question: question
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      
      if (data.success && data.response) {
        return data.response;
      } else {
        throw new Error('Invalid response from AI service');
      }
    } catch (error) {
      console.error('AI API Error:', error);
      throw error;
    }
  };

  const handleSendMessage = async () => {
    if (!message.trim()) return;

    // Add user message
    const userMessage = {
      type: 'user',
      text: message,
      timestamp: new Date()
    };
    
    setMessages(prev => [...prev, userMessage]);
    
    // Update conversation history for context
    const updatedHistory = [...conversationHistory, { role: 'user', content: message }];
    setConversationHistory(updatedHistory);
    
    // Clear input field
    const currentMessage = message;
    setMessage('');
    
    // Show loading indicator
    setIsLoading(true);
    const loadingMessage = {
      type: 'bot',
      text: 'loading',
      timestamp: new Date()
    };
    setMessages(prev => [...prev, loadingMessage]);

    try {
      // Call AI API
      const aiResponse = await callAIAPI(currentMessage);
      
      // Remove loading message and add actual response
      setMessages(prev => {
        const filteredMessages = prev.filter(msg => msg.text !== 'loading');
        return [...filteredMessages, {
          type: 'bot',
          text: aiResponse,
          timestamp: new Date()
        }];
      });
      
      // Update conversation history with bot response
      setConversationHistory([...updatedHistory, { role: 'assistant', content: aiResponse }]);
      
    } catch (error) {
      // Remove loading message and show error
      setMessages(prev => {
        const filteredMessages = prev.filter(msg => msg.text !== 'loading');
        return [...filteredMessages, {
          type: 'bot',
          text: 'Our AI Agent is currently down for upgrades please come back soon',
          timestamp: new Date(),
          isError: true
        }];
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Loading animation component
  const LoadingDots = () => (
    <div style={{ display: 'flex', gap: '4px', padding: '8px' }}>
      <div style={{
        width: '8px',
        height: '8px',
        borderRadius: '50%',
        backgroundColor: '#6B7280',
        animation: 'pulse 1.4s ease-in-out infinite',
        animationDelay: '0s'
      }} />
      <div style={{
        width: '8px',
        height: '8px',
        borderRadius: '50%',
        backgroundColor: '#6B7280',
        animation: 'pulse 1.4s ease-in-out infinite',
        animationDelay: '0.2s'
      }} />
      <div style={{
        width: '8px',
        height: '8px',
        borderRadius: '50%',
        backgroundColor: '#6B7280',
        animation: 'pulse 1.4s ease-in-out infinite',
        animationDelay: '0.4s'
      }} />
    </div>
  );

  const styles = {
    widgetButton: {
      position: 'fixed',
      bottom: '24px',
      right: '24px',
      width: '60px',
      height: '60px',
      borderRadius: '50%',
      background: 'linear-gradient(135deg, #125e82 0%, #1f8dbf 100%)',
      color: 'white',
      border: 'none',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
      transition: 'all 0.3s',
      zIndex: 1000
    },
    chatWindow: {
      position: 'fixed',
      bottom: '100px',
      right: '24px',
      width: '380px',
      height: isMinimized ? '60px' : '500px',
      backgroundColor: 'white',
      borderRadius: '12px',
      boxShadow: '0 10px 40px rgba(0, 0, 0, 0.15)',
      display: 'flex',
      flexDirection: 'column',
      zIndex: 1000,
      transition: 'height 0.3s ease'
    },
    chatHeader: {
      background: 'linear-gradient(135deg, #125e82 0%, #1f8dbf 100%)',
      color: 'white',
      padding: '16px 20px',
      borderRadius: '12px 12px 0 0',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center'
    },
    chatBody: {
      flex: 1,
      overflowY: 'auto',
      padding: '20px',
      display: isMinimized ? 'none' : 'flex',
      flexDirection: 'column',
      gap: '12px'
    },
    chatFooter: {
      padding: '16px',
      borderTop: '1px solid #E5E7EB',
      display: isMinimized ? 'none' : 'flex',
      gap: '8px'
    },
    messageInput: {
      flex: 1,
      padding: '10px 14px',
      border: '1px solid #E5E7EB',
      borderRadius: '6px',
      fontSize: '14px',
      outline: 'none',
      transition: 'border-color 0.2s'
    },
    sendButton: {
      padding: '10px 16px',
      background: 'linear-gradient(135deg, #125e82 0%, #1f8dbf 100%)',
      color: 'white',
      border: 'none',
      borderRadius: '6px',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      transition: 'transform 0.2s',
      opacity: isLoading ? 0.5 : 1
    },
    message: {
      padding: '10px 14px',
      borderRadius: '8px',
      fontSize: '14px',
      lineHeight: '1.5',
      maxWidth: '80%'
    },
    userMessage: {
      background: 'linear-gradient(135deg, #125e82 0%, #1f8dbf 100%)',
      color: 'white',
      alignSelf: 'flex-end',
      marginLeft: 'auto'
    },
    botMessage: {
      backgroundColor: '#F3F4F6',
      color: '#374151',
      alignSelf: 'flex-start'
    },
    errorMessage: {
      backgroundColor: '#FEE2E2',
      color: '#991B1B',
      alignSelf: 'flex-start',
      borderLeft: '3px solid #EF4444'
    },
    loadingMessage: {
      backgroundColor: '#F3F4F6',
      alignSelf: 'flex-start',
      display: 'flex',
      alignItems: 'center',
      padding: '6px 10px'
    }
  };

  // Add CSS animation for loading dots
  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = `
      @keyframes pulse {
        0%, 60%, 100% {
          opacity: 0.3;
          transform: scale(0.8);
        }
        30% {
          opacity: 1;
          transform: scale(1.2);
        }
      }
    `;
    document.head.appendChild(style);
    return () => {
      document.head.removeChild(style);
    };
  }, []);

  return (
    <>
      {/* Chat Widget Button */}
      {!isOpen && (
        <button
          style={styles.widgetButton}
          onClick={() => setIsOpen(true)}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = 'scale(1.1)';
            e.currentTarget.style.boxShadow = '0 6px 20px rgba(0, 0, 0, 0.2)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'scale(1)';
            e.currentTarget.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.15)';
          }}
        >
          <MessageSquare size={28} />
        </button>
      )}

      {/* Chat Window */}
      {isOpen && (
        <div style={styles.chatWindow}>
          {/* Header */}
          <div style={styles.chatHeader}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <MessageSquare size={20} />
              <span style={{ fontWeight: '600' }}>Open-Enroll Assistant</span>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={() => setIsMinimized(!isMinimized)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'white',
                  cursor: 'pointer',
                  padding: '4px'
                }}
              >
                {isMinimized ? <Maximize2 size={18} /> : <Minimize2 size={18} />}
              </button>
              <button
                onClick={() => setIsOpen(false)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'white',
                  cursor: 'pointer',
                  padding: '4px'
                }}
              >
                <X size={18} />
              </button>
            </div>
          </div>

          {/* Messages */}
          <div style={styles.chatBody}>
            {messages.map((msg, index) => {
              // Handle loading message
              if (msg.text === 'loading') {
                return (
                  <div key={index} style={styles.loadingMessage}>
                    <LoadingDots />
                  </div>
                );
              }
              
              // Handle regular messages
              return (
                <div
                  key={index}
                  style={{
                    ...styles.message,
                    ...(msg.type === 'user' 
                      ? styles.userMessage 
                      : msg.isError 
                        ? styles.errorMessage 
                        : styles.botMessage)
                  }}
                >
                  {msg.text}
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div style={styles.chatFooter}>
            <input
              type="text"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyPress={(e) => {
                if (e.key === 'Enter' && !isLoading) {
                  handleSendMessage();
                }
              }}
              placeholder="Type your message..."
              style={styles.messageInput}
              disabled={isLoading}
              onFocus={(e) => e.target.style.borderColor = '#3B82F6'}
              onBlur={(e) => e.target.style.borderColor = '#E5E7EB'}
            />
            <button
              onClick={handleSendMessage}
              style={styles.sendButton}
              disabled={isLoading}
              onMouseEnter={(e) => !isLoading && (e.target.style.transform = 'scale(1.05)')}
              onMouseLeave={(e) => e.target.style.transform = 'scale(1)'}
            >
              <Send size={18} />
            </button>
          </div>
        </div>
      )}
    </>
  );
};

export default ChatWidget;