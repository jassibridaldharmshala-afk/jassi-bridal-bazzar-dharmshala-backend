const router = require('express').Router();
const cart = require('../controllers/cartController');
const { protect } = require('../middleware/authMiddleware');
// A supplied login must be valid. Returning a guest cart for an expired token
// hides the customer's saved items and prevents the client's token refresh.
router.use((req, res, next) => req.headers.authorization ? protect(req, res, next) : next());
router.get('/', cart.getCart);
router.post('/', cart.addToCart);
router.post('/selection', cart.selectCartItems);
router.post('/remove-items', cart.removeCartItems);
router.put('/:itemId', cart.updateCartItem);
router.delete('/:itemId', cart.removeCartItem);
router.delete('/', cart.clearCart);
module.exports = router;
