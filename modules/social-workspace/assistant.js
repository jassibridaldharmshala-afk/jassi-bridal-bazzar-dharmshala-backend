const { Thread, Message, Post } = require('./models');
const Product = require('../../models/Product');
const { generateGeminiJson } = require('../../services/geminiJson.service');
const meta = require('./meta');

function clean(value, max = 2200) { return String(value || '').trim().replace(/[\u0000-\u001f]/g, ' ').slice(0, max); }

async function suggestReply(req, res) {
  const thread = await Thread.findOne({ _id: req.params.id, storeId: req.socialStore._id }).lean();
  if (!thread) throw meta.fail('Conversation not found.', 404);
  const messages = await Message.find({ threadId: thread._id, storeId: thread.storeId }).sort({ sentAt: -1 }).limit(12).lean();
  const transcript = messages.reverse().map(item => `${item.direction === 'inbound' ? 'Customer' : 'Store'}: ${clean(item.text, 600) || '[attachment]'}`).join('\n').slice(0, 7000);
  const { raw, model } = await generateGeminiJson({ maxOutputTokens: 500, temperature: 0.3, parts: [{ text: `You assist an Indian ecommerce support team. Draft one concise, polite reply using only facts present in the transcript. Never invent stock, price, delivery, refund or order status. If facts are missing, ask a clear question. Return strict JSON {"reply":"..."}. This is a suggestion and will be reviewed by a human.\n\n${transcript}` }] });
  const reply = clean(raw.reply, 1000);
  if (!reply) throw meta.fail('The assistant did not produce a usable reply.');
  res.json({ reply, model, requiresApproval: true });
}

async function suggestCaption(req, res) {
  const post = req.params.id ? await Post.findOne({ _id: req.params.id, storeId: req.socialStore._id }).lean() : null;
  const productId = post?.productId || req.body.productId;
  const product = productId ? await Product.findOne({ _id: productId, isActive: true, isArchived: { $ne: true } }).select('name price shortDescription brand category tags colors').lean() : null;
  if (!post && !product) throw meta.fail('Choose a product or save the draft before requesting captions.', 404);
  const facts = { name: post?.productName || product?.name, price: post?.productPrice ?? product?.price, description: product?.shortDescription, category: product?.category, tags: product?.tags, colors: product?.colors, url: post?.productUrl };
  const { raw, model } = await generateGeminiJson({ maxOutputTokens: 900, temperature: 0.5, parts: [{ text: `Create premium ecommerce social captions from these facts only. Do not invent offers, fabric, sizes, stock or delivery promises. Use Indian English and a short call to action. Return strict JSON {"base":"...","instagram":"...","facebook":"..."}. Instagram may include up to 8 relevant hashtags; Facebook should be conversational. Every value must be at most 2200 characters.\n\nFacts: ${JSON.stringify(facts)}` }] });
  const captions = { base: clean(raw.base), instagram: clean(raw.instagram), facebook: clean(raw.facebook) };
  if (!captions.base && !captions.instagram && !captions.facebook) throw meta.fail('The assistant did not produce usable captions.');
  res.json({ captions, model, requiresApproval: true });
}
module.exports = { suggestReply, suggestCaption };
