const Conversation = require('../models/Conversation');
const Message = require('../models/Message');

async function openConversation({
  storeId,
  channel = 'WEBSITE',
  subject,
  customer,
  customerName,
  customerEmail,
  customerPhone,
  order,
  returnRequest,
  contactMessage,
  body,
  author,
  authorRole = 'customer',
}) {
  const conversation = await Conversation.create({
    storeId: storeId || undefined,
    channel,
    status: 'OPEN',
    subject,
    customer,
    customerName,
    customerEmail,
    customerPhone,
    order,
    returnRequest,
    contactMessage,
    lastMessageAt: new Date(),
  });

  if (body) {
    await Message.create({
      conversation: conversation._id,
      storeId: storeId || undefined,
      author,
      authorRole,
      body,
    });
  }

  return conversation;
}

async function addMessage(conversation, { body, author, authorRole = 'seller', storeId }) {
  const message = await Message.create({
    conversation: conversation._id,
    storeId: storeId || conversation.storeId,
    author,
    authorRole,
    body,
  });
  conversation.lastMessageAt = new Date();
  if (conversation.status === 'CLOSED') conversation.status = 'OPEN';
  await conversation.save();
  return message;
}

module.exports = { addMessage, openConversation };
