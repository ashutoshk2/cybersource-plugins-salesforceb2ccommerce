'use strict';

/*
    This line has to be updated to reference checkoutHelpers.js from the site cartridge's checkoutHelpers.js
*/

var base = module.superModule;
var renderTemplateHelper = require('*/cartridge/scripts/renderTemplateHelper');
var Transaction = require('dw/system/Transaction');
var Status = require('dw/system/Status');
var CybersourceConstants = require('*/cartridge/scripts/utils/CybersourceConstants');
var OrderMgr = require('dw/order/OrderMgr');
var HookMgr = require('dw/system/HookMgr');
var secureResponseHelper = require('*/cartridge/scripts/helpers/secureResponseHelper');
var secureRender = secureResponseHelper.secureRender;


/**
 * creates a new payment instrument in customers wallet if payment instrument is new
 * otherwise returns the already existing payment instrument
 * @param {*} billingDataObj billing information entered by the user
 * @param {*} currentBasket The current basket
 * @param {*} customer The current customer
 * @returns {*} obj
 */
function savePaymentInstrumentToWallet(billingDataObj, currentBasket, customer) {
    var billingData = billingDataObj;
    var PaymentMgr = require('dw/order/PaymentMgr');
    var PaymentInstrument = require('dw/order/PaymentInstrument');
    var BasketMgr = require('dw/order/BasketMgr');
    var Site = require('dw/system/Site');
    var Resource = require('dw/web/Resource');
    var CsSAType = Site.getCurrent().getCustomPreferenceValue('CsSAType').value;
    var CardHelper = require('*/cartridge/scripts/helper/CardHelper');
    var PaymentInstrumentUtils = require('*/cartridge/scripts/utils/PaymentInstrumentUtils');
    if (CsSAType != null && CsSAType === Resource.msg('cssatype.SA_FLEX', 'cybersource', null)) {
        billingData.paymentInformation.cardType.value = CardHelper.getCardType(billingData.paymentInformation.cardType.value);
    }
    var verifyDuplicates = false;

    var basket = BasketMgr.getCurrentOrNewBasket();
    var tokenizationResult = { subscriptionID: '', error: '' };
    var wallet = customer.getProfile().getWallet();
    var customerProfile = customer.getProfile();
    var saveCard = PaymentInstrumentUtils.cardSaveLimit(customerProfile);
    var paymentInstruments = wallet.getPaymentInstruments(PaymentInstrument.METHOD_CREDIT_CARD);
    var enableTokenization = Site.getCurrent().getCustomPreferenceValue('CsTokenizationEnable').value;
    var processor = PaymentMgr.getPaymentMethod(PaymentInstrument.METHOD_CREDIT_CARD).getPaymentProcessor();
    if (enableTokenization.equals('YES') && !saveCard.addCardLimitError && HookMgr.hasHook('app.payment.processor.' + processor.ID.toLowerCase())) {
        verifyDuplicates = true;
        tokenizationResult = HookMgr.callHook('app.payment.processor.' + processor.ID.toLowerCase(), 'CreatePaymentToken', 'billing');
    }
    var payInstrument = CardHelper.getNonGCPaymemtInstument(basket);
    var storedPaymentInstrument;
    var alreadyExists = false;

    Transaction.begin();
    if (saveCard.addCardLimit && saveCard.savedCCTimeNew) {
        Transaction.wrap(function () {
            customerProfile.custom.savedCCRateLookBack = new Date();
            customerProfile.custom.savedCCRateCount = 1;
        });
    }
    var savedCreditCards = customer.getProfile().getWallet().getPaymentInstruments(PaymentInstrument.METHOD_CREDIT_CARD);
    var ccNumber = billingData.paymentInformation.cardNumber.value;
     
    for (var i = 0; i < savedCreditCards.length; i++) {
        var creditcard = savedCreditCards[i];
        var creditcardNo = creditcard.getCreditCardNumber();
        if (creditcard.creditCardExpirationMonth === billingData.paymentInformation.expirationMonth.value
            && creditcard.creditCardExpirationYear === billingData.paymentInformation.expirationYear.value
            && creditcard.creditCardType === billingData.paymentInformation.cardType.value
            && creditcardNo.toString().substring(creditcardNo.length - 4).equals(ccNumber.substring(ccNumber.length - 4))) {
            storedPaymentInstrument = creditcard;
            alreadyExists = true;
            break;
        }
    }

    if (!alreadyExists && !empty(tokenizationResult.subscriptionID)) {
        storedPaymentInstrument = wallet.createPaymentInstrument(PaymentInstrument.METHOD_CREDIT_CARD);

        storedPaymentInstrument.setCreditCardHolder(
            currentBasket.billingAddress.fullName
        );
        storedPaymentInstrument.setCreditCardNumber(
            billingData.paymentInformation.cardNumber.value
        );
        storedPaymentInstrument.setCreditCardType(
            billingData.paymentInformation.cardType.value
        );
        storedPaymentInstrument.setCreditCardExpirationMonth(
            billingData.paymentInformation.expirationMonth.value
        );
        storedPaymentInstrument.setCreditCardExpirationYear(
            billingData.paymentInformation.expirationYear.value
        );

         
        if (!tokenizationResult.error && !empty(tokenizationResult.subscriptionID)) {
            storedPaymentInstrument.setCreditCardToken(tokenizationResult.subscriptionID);
            storedPaymentInstrument.custom.isCSToken = true;
            payInstrument.setCreditCardToken(tokenizationResult.subscriptionID);
        }
        if (CsSAType != null && CsSAType === Resource.msg('cssatype.SA_FLEX', 'cybersource', null)) {
            // eslint-disable-next-line
            var flexResponse = session.forms.billing.creditCardFields.flexresponse.value;
        }
    }

    if (verifyDuplicates) {
        PaymentInstrumentUtils.removeDuplicates({
            PaymentInstruments: paymentInstruments,
            CreditCardFields: {
                expirationMonth: billingData.paymentInformation.expirationMonth.value,
                expirationYear: billingData.paymentInformation.expirationYear.value,
                cardType: billingData.paymentInformation.cardType.value,
                cardNumber: billingData.paymentInformation.cardNumber.value
            }
        });
    }
    Transaction.commit();
    return storedPaymentInstrument;
}

/**
 * handles the payment authorization for each payment instrument
 * @param {dw.order.Order} order - the order object
 * @param {string} orderNumber - The order number for the order
 * @returns {Object} an error object
 */
function handlePayments(order, orderNumber, payerauthArgs) {
    var PaymentMgr = require('dw/order/PaymentMgr');
    var authorizationResult;
    var result = {};

    if (order.totalNetPrice !== 0.00) {
        var paymentInstruments = order.paymentInstruments;

        if (paymentInstruments.length === 0) {
            Transaction.wrap(function () { OrderMgr.failOrder(order, true); });
            result.error = true;
        }

        if (!result.error) {
            for (var i = 0; i < paymentInstruments.length; i += 1) {
                var paymentInstrument = paymentInstruments[i];
                var paymentProcessor = PaymentMgr.getPaymentMethod(paymentInstrument.paymentMethod).paymentProcessor;
                if (paymentProcessor === null) {
                    Transaction.begin();
                    paymentInstrument.paymentTransaction.setTransactionID(orderNumber);
                    Transaction.commit();
                } else {
                    if (HookMgr.hasHook('app.payment.processor.' + paymentProcessor.ID.toLowerCase())) {
                        authorizationResult = HookMgr.callHook(
                            'app.payment.processor.' + paymentProcessor.ID.toLowerCase(),
                            'Authorize',
                            orderNumber,
                            paymentInstrument,
                            paymentProcessor,
                            payerauthArgs
                        );
                    } else {
                        authorizationResult = HookMgr.callHook(
                            'app.payment.processor.default',
                            'Authorize'
                        );
                    }

                    if (authorizationResult.error) {
                        Transaction.wrap(function () { OrderMgr.failOrder(order, true); });
                        result.error = true;
                        break;
                    }
                }
            }
        }
    }

    return authorizationResult;
}

/**
 * Validates payment
 * @param {Object} req - The local instance of the request object
 * @param {dw.order.Basket} currentBasket - The current basket
 * @returns {Object} an object that has error information
 */
function validatePayment(req, currentBasket) {
    var Site = require('dw/system/Site');
    var PaymentMgr = require('dw/order/PaymentMgr');
    var PaymentInstrument = require('dw/order/PaymentInstrument');

    var CsSAType = Site.getCurrent().getCustomPreferenceValue('CsSAType').value;
    var applicablePaymentCards;
    var applicablePaymentMethods;
    var creditCardPaymentMethod = PaymentMgr.getPaymentMethod(PaymentInstrument.METHOD_CREDIT_CARD);
    var paymentAmount = currentBasket.totalGrossPrice.value;
    var countryCode = req.geolocation.countryCode;
    var currentCustomer = req.currentCustomer.raw;
    var paymentInstruments = currentBasket.paymentInstruments;
    var result = {};

    applicablePaymentMethods = PaymentMgr.getApplicablePaymentMethods(
        currentCustomer,
        countryCode,
        paymentAmount
    );
    applicablePaymentCards = creditCardPaymentMethod.getApplicablePaymentCards(
        currentCustomer,
        countryCode,
        paymentAmount
    );

    var invalid = true;

    for (var i = 0; i < paymentInstruments.length; i += 1) {
        var paymentInstrument = paymentInstruments[i];

        if (PaymentInstrument.METHOD_GIFT_CERTIFICATE.equals(paymentInstrument.paymentMethod)) {
            invalid = false;
        }

        if (CsSAType && PaymentInstrument.METHOD_CREDIT_CARD.equals(paymentInstrument.paymentMethod)) {
            invalid = false;
        }

        var paymentMethod = PaymentMgr.getPaymentMethod(paymentInstrument.getPaymentMethod());

        if (paymentMethod && applicablePaymentMethods.contains(paymentMethod)) {
            if (PaymentInstrument.METHOD_CREDIT_CARD.equals(paymentInstrument.paymentMethod)) {
                var card = PaymentMgr.getPaymentCard(paymentInstrument.creditCardType);

                // Checks whether payment card is still applicable.
                if (card && applicablePaymentCards.contains(card)) {
                    invalid = false;
                }
            } else {
                invalid = false;
            }
        }

        if (invalid) {
            break; 
        }
    }

    result.error = invalid;
    return result;
}

/**
 * renders the user's stored payment Instruments
 * @param {*} req The request object
 * @param {*} paymentInstruments paymentInstruments
 * @param {*} paymentID paymentID
 * @returns {*} obj
 */
function getOrderPaymentInstruments(req, paymentInstruments, paymentID) {
    var result;
    var context;
    var template = 'checkout/billing/orderPaymentInstrument';

    context = { paymentInstruments: paymentInstruments, paymentOption: paymentID };
    result = renderTemplateHelper.getRenderedHtml(
        context,
        template
    );

    return result || null;
}

/**
 * Function
 * @param {*} basket basket
 * @returns {*} obj
 */
function getPayPalInstrument(basket) {
    for (var i = 0; i < basket.paymentInstruments.length; i += 1) {
        var paymentInstrument = basket.paymentInstruments[i];
        if (paymentInstrument.paymentMethod === 'PAYPAL' || paymentInstrument.paymentMethod === 'PAYPAL_CREDIT') {
            return paymentInstrument;
        }
    }
    return null;
}

/**
 * Validate PayPal email & phone number fields
 * @param {Object} form - the form object with pre-validated form fields
 * @returns {Object} the names of the invalid form fields
 */
function validatePPLForm(form) {
    return base.validateFields(form);
}

/**
 * Function
 * @param {*} basket basket
 */
function handlePayPal(basket) {
    var ccPaymentInstrs = basket.getPaymentInstruments();


    var iter = ccPaymentInstrs.iterator();
    var existingPI = null;
    var PaymentInstrument = require('dw/order/PaymentInstrument');

    while (iter.hasNext()) {
        existingPI = iter.next();
        if (existingPI.paymentMethod.equals(PaymentInstrument.METHOD_GIFT_CERTIFICATE)) {
             
            continue;
        } else if (existingPI.paymentMethod.equals('PAYPAL') || existingPI.paymentMethod.equals('PAYPAL_CREDIT')) {
            basket.removePaymentInstrument(existingPI);
        }
    }
}

/**
 * Function
 */
function clearPaymentAttributes() {
     
    delete session.privacy.isPaymentRedirectInvoked;
    delete session.privacy.paymentType;
    delete session.privacy.orderId;
     
}

/**
 * Function
 * @param {*} order order
 * @returns {*} obj
 */
function reCreateBasket(order) {
    var BasketMgr = require('dw/order/BasketMgr');
    Transaction.wrap(function () {
        OrderMgr.failOrder(order, true);
    });
    return BasketMgr.getCurrentBasket();
}

/**
 * Function
 * @param {*} order order
 * @returns {*} obj
 */
function handleSilentPostAuthorize(order, payerauthArgs) {
    var PaymentMgr = require('dw/order/PaymentMgr');
    var paymentInstrument;
    if (order !== null) {
        var CardHelper = require('*/cartridge/scripts/helper/CardHelper');
        paymentInstrument = CardHelper.getNonGCPaymemtInstument(order);
    }
    var authorizationResult;
    var paymentProcessor = PaymentMgr.getPaymentMethod(paymentInstrument.paymentMethod).paymentProcessor;
    if (HookMgr.hasHook('app.payment.processor.' + paymentProcessor.ID.toLowerCase())) {
        authorizationResult = HookMgr.callHook(
            'app.payment.processor.' + paymentProcessor.ID.toLowerCase(),
            'SilentPostAuthorize',
            order.orderNo,
            paymentInstrument,
            paymentProcessor,
            payerauthArgs
        );
    }
    return authorizationResult;
}

/**
 * Function
 * @param {*} order order
 * @param {*} customerObj customerObj
 * @param {*} res res
 */
function addOrUpdateToken(order, customerObj, res) {
    var URLUtils = require('dw/web/URLUtils');
    var CardHelper = require('*/cartridge/scripts/helper/CardHelper');
    var paymentInstrument;
    if (order !== null) {
        paymentInstrument = CardHelper.getNonGCPaymemtInstument(order);
    }
    CardHelper.addOrUpdateToken(paymentInstrument, customerObj);
     
    session.privacy.orderId = order.orderNo;
    res.redirect(URLUtils.https('COPlaceOrder-SilentPostSubmitOrder'));
}

/**
 * Function
 * @param {*} basket basket
 * @returns {*} obj
 */
function getNonGCPaymemtInstument(basket) {
    var CardHelper = require('*/cartridge/scripts/helper/CardHelper');
    return CardHelper.getNonGCPaymemtInstument(basket);
}

/**
 * Sets the payment transaction amount
 * @param {dw.order.Basket} currentBasket - The current basket
 * @returns {Object} an error object
 */
function calculatePaymentTransaction(currentBasket) {
    var result = { error: false };

    try {
        Transaction.wrap(function () {
            var paymentInstruments = currentBasket.paymentInstruments;

            if (!paymentInstruments.length) {
                return;
            }
            var orderTotal = currentBasket.totalGrossPrice;
            var paymentInstrument = paymentInstruments[0];

            if (!(paymentInstrument.paymentMethod.equals(CybersourceConstants.METHOD_PAYPAL) || paymentInstrument.paymentMethod.equals(CybersourceConstants.METHOD_PAYPAL_CREDIT))) {
                paymentInstrument.paymentTransaction.setAmount(orderTotal);
            }
        });
    } catch (e) {
        result.error = true;
    }

    return result;
}


/**
 * function
 * @param {*} args args
 * @returns {*} obj
 */
function failOrder(args) {
    var Cybersource = require('*/cartridge/scripts/Cybersource');
    var orderResult = Cybersource.GetOrder(args.Order);
    if (orderResult.error) {
         
        args.PlaceOrderError = orderResult.PlaceOrderError;
        return args;
    }
    var order = orderResult.Order;
    var PlaceOrderError = args.PlaceOrderError != null ? args.PlaceOrderError : new Status(Status.ERROR, 'confirm.error.declined', 'Payment Declined');
    session.privacy.SkipTaxCalculation = false;
    var failResult = Transaction.wrap(function () {
        OrderMgr.failOrder(order, true);
        return {
            error: true,
            PlaceOrderError: PlaceOrderError
        };
    });
    if (failResult.error) {
         
        args.PlaceOrderError = failResult.PlaceOrderError;
    }
    return args;
}

/**
 * Create Order and set to NOT CONFIRMED
 * @param {*} orderId orderId
 * @param {*} req req
 * @param {*} res res
 * @param {*} next next
 * @returns {*} obj
 */
function reviewOrder(orderId, req, res, next) {
    var URLUtils = require('dw/web/URLUtils');
    if (session.privacy.orderId && session.privacy.orderId !== orderId) {
        res.redirect(URLUtils.url('Cart-Show'));
        return next();
    }
    var order = OrderMgr.getOrder(orderId);
    var fraudResult = runFraudDetectionAndFail(order, order, req, res);
    if (fraudResult.failed) {
        return next();
    }

    base.sendConfirmationEmail(order, req.locale.id);

    //  Set Order confirmation status to NOT CONFIRMED
    var Order = require('dw/order/Order');
    Transaction.wrap(function () {
        order.setConfirmationStatus(Order.CONFIRMATION_STATUS_NOTCONFIRMED);
    });

    // Reset usingMultiShip after successful Order placement
    req.session.privacyCache.set('usingMultiShipping', false);
    res.redirect(URLUtils.https('COPlaceOrder-SubmitOrderConformation', 'ID', order.orderNo, 'token', order.orderToken));
    return next();
}

/**
 * Submit the order and send order confirmation email
 * @param {*} orderId orderId
 * @param {*} req req
 * @param {*} res res
 * @param {*} next next
 * @returns {*} obj
 */
function submitOrder(orderId, req, res, next) {
    var URLUtils = require('dw/web/URLUtils');
    if (session.privacy.orderId && session.privacy.orderId !== orderId) {
        res.redirect(URLUtils.url('Cart-Show'));
        return next();
    }
    var order = OrderMgr.getOrder(orderId);
    var Resource = require('dw/web/Resource');
    var fraudResult = runFraudDetectionAndFail(order, order, req, res);
    if (fraudResult.failed) {
        return next();
    }
    var fraudDetectionStatus = fraudResult.fraudDetectionStatus;

    // Place the order
    var placeOrderResult = base.placeOrder(order, fraudDetectionStatus);
    if (placeOrderResult.error) {
        res.redirect(URLUtils.https('Checkout-Begin', 'stage', 'placeOrder', 'PlaceOrderError', Resource.msg('error.technical', 'checkout', null)));
        return next();
    }

    //  Set order confirmation status to not confirmed for REVIEW orders.
    if (session.privacy.CybersourceFraudDecision === 'REVIEW') {
        var Order = require('dw/order/Order');
        Transaction.wrap(function () {
            order.setConfirmationStatus(Order.CONFIRMATION_STATUS_NOTCONFIRMED);
        });
    }

    base.sendConfirmationEmail(order, req.locale.id);
    // Reset using MultiShip after successful Order placement
    req.session.privacyCache.set('usingMultiShipping', false);
    res.redirect(URLUtils.https('COPlaceOrder-SubmitOrderConformation', 'ID', order.orderNo, 'token', order.orderToken));
    return next();
}


//  /**
//   * Attempts to place the order
//   * @param {dw.order.Order} order - The order object to be placed
//   * @param {Object} fraudDetectionStatus - an Object returned by the fraud detection hook
//   * @returns {Object} an error object
//   */
function placeOrder(order, fraudDetectionStatus) {
    var result = { error: false };
    var Status = require('dw/system/Status');
    var Order = require('dw/order/Order');

    try {
        Transaction.begin();
        if (fraudDetectionStatus.status === 'success') {
            var placeOrderStatus = OrderMgr.placeOrder(order);
            if (placeOrderStatus === Status.ERROR) {
                throw new Error();
            }
        }

        if (fraudDetectionStatus.status === 'flag') {
            order.setConfirmationStatus(Order.CONFIRMATION_STATUS_NOTCONFIRMED);
        } else {
            order.setConfirmationStatus(Order.CONFIRMATION_STATUS_CONFIRMED);
        }

        order.setExportStatus(Order.EXPORT_STATUS_READY);
        Transaction.commit();
    } catch (e) {
        Transaction.wrap(function () { OrderMgr.failOrder(order, true); });
        result.error = true;
    }

    return result;
}

/**
 * function
 * @param {*} order order
 * @param {*} req req
 * @param {*} res res
 * @param {*} next next
 * @returns {*} obj
 */
function submitApplePayOrder(order, req, res, next) {
    var server = require('server');
    var OrderModel = require('*/cartridge/models/order');

    if (!order || req.querystring.order_token !== order.getOrderToken()) {
        return next(new Error('Order token does not match'));
    }
    var fraudDetectionStatus = HookMgr.callHook('app.fraud.detection', 'fraudDetection', order);
    var orderPlacementStatus = base.placeOrder(order, fraudDetectionStatus);

    if (orderPlacementStatus.error) {
        return next(new Error('Could not place order'));
    }

    var config = {
        numberOfLineItems: '*'
    };
    var orderModel = new OrderModel(order, { config: config });
    if (!req.currentCustomer.profile) {
        var passwordForm = server.forms.getForm('newPasswords');
        passwordForm.clear();
        secureRender(res, 'checkout/confirmation/confirmation', {
            order: orderModel,
            returningCustomer: false,
            passwordForm: passwordForm
        });
    } else {
        secureRender(res, 'checkout/confirmation/confirmation', {
            order: orderModel,
            returningCustomer: true
        });
    }
    return next();
}

/**
 * Resolves an order from req.form / req.querystring using orderID + orderToken,
 * with a fallback to session.privacy.orderId. The token check is required for
 * 3DS / payer-auth flows to prevent ownership bypass.
 * @param {Object} req SFRA request
 * @param {Object} [options] options
 * @param {string[]} [options.idKeys] keys to try for orderID (default: ['orderID', 'OrderNo', 'orderNo'])
 * @param {string[]} [options.tokenKeys] keys to try for orderToken (default: ['orderToken'])
 * @returns {{ order: dw.order.Order|null, orderID: string|null, orderToken: string|null }}
 */
function resolveOrderFromRequest(req, options) {
    var idKeys = (options && options.idKeys) || ['orderID', 'OrderNo', 'orderNo'];
    var tokenKeys = (options && options.tokenKeys) || ['orderToken'];
    var sources = [req.form, req.querystring].filter(function (s) { return s; });

    function pick(keys) {
        for (var s = 0; s < sources.length; s++) {
            var src = sources[s];
            for (var k = 0; k < keys.length; k++) {
                var v = src[keys[k]];
                if (v !== null && v !== undefined && v !== '') {
                    return v;
                }
            }
        }
        return null;
    }

    var orderID = pick(idKeys);
    var orderToken = pick(tokenKeys);
    var order = null;

    if (orderID) {
        if (orderToken) {
            order = OrderMgr.getOrder(orderID, orderToken);
        } else if (session.privacy.orderId && session.privacy.orderId === orderID) {
            order = OrderMgr.getOrder(orderID);
        }
    }
    return { order: order, orderID: orderID, orderToken: orderToken };
}

/**
 * Dispatches Handle hook for the given payment method, falling back to
 * app.payment.processor.default when no specific hook is registered.
 * @param {string} paymentMethodID payment method ID
 * @returns {*} hook result
 */
function invokeHandleHook(paymentMethodID) {
    var PaymentMgr = require('dw/order/PaymentMgr');
    var HookMgr = require('dw/system/HookMgr');
    var processor = PaymentMgr.getPaymentMethod(paymentMethodID).getPaymentProcessor();
    var hookID = 'app.payment.processor.' + processor.ID.toLowerCase();
    var args = Array.prototype.slice.call(arguments, 1);
    if (HookMgr.hasHook(hookID)) {
        return HookMgr.callHook.apply(HookMgr, [hookID, 'Handle'].concat(args));
    }
    return HookMgr.callHook('app.payment.processor.default', 'Handle');
}

/**
 * Fails the order in a transaction, clears session.privacy.orderId, and
 * redirects to Checkout-Begin at the requested stage with the supplied
 * resource-message error. Consolidates the failure pattern repeated across
 * payment-result branches.
 * @param {dw.order.Order} order order to fail
 * @param {Object} res response
 * @param {Object} options { stage, errorParam, msgKey, msgBundle, resetSkipTax }
 * @returns {void}
 */
function failOrderAndRedirect(order, res, options) {
    var Transaction = require('dw/system/Transaction');
    var OrderMgrLocal = require('dw/order/OrderMgr');
    var URLUtilsLocal = require('dw/web/URLUtils');
    var ResourceLocal = require('dw/web/Resource');
    var stage = (options && options.stage) || 'payment';
    var errorParam = (options && options.errorParam) || 'payerAuthError';
    var msgKey = (options && options.msgKey) || 'error.technical';
    var msgBundle = (options && options.msgBundle) || 'checkout';
    if (order) {
        Transaction.wrap(function () { OrderMgrLocal.failOrder(order, true); });
    }
    if (options && options.resetSkipTax) {
        session.privacy.SkipTaxCalculation = false;
    }
    delete session.privacy.orderId;
    res.redirect(URLUtilsLocal.https('Checkout-Begin', 'stage', stage, errorParam, ResourceLocal.msg(msgKey, msgBundle, null)));
}

/**
 * Runs the app.fraud.detection hook and, when status is 'fail', fails the order,
 * sets the privacyCache flag, optionally clears session.privacy.orderId, and
 * redirects to Error-ErrorCode. Returns { failed, fraudDetectionStatus } so the
 * caller can short-circuit and reuse the status object for placeOrder.
 * @param {dw.order.Basket|dw.order.Order} subject hook subject (basket or order)
 * @param {dw.order.Order} order order to fail on 'fail' status (may be null in pre-order flows)
 * @param {Object} req SFRA request
 * @param {Object} res SFRA response
 * @param {Object} [options] options
 * @param {boolean} [options.deleteOrderId=false] when true, also delete session.privacy.orderId
 * @returns {{failed: boolean, fraudDetectionStatus: Object}} result
 */
function runFraudDetectionAndFail(subject, order, req, res, options) {
    var URLUtilsLocal = require('dw/web/URLUtils');
    var HookMgrLocal = require('dw/system/HookMgr');
    var TransactionLocal = require('dw/system/Transaction');
    var OrderMgrLocal = require('dw/order/OrderMgr');
    var fraudDetectionStatus = HookMgrLocal.callHook('app.fraud.detection', 'fraudDetection', subject);
    if (fraudDetectionStatus && fraudDetectionStatus.status === 'fail') {
        if (order) {
            TransactionLocal.wrap(function () { OrderMgrLocal.failOrder(order, true); });
        }
        if (req && req.session && req.session.privacyCache) {
            req.session.privacyCache.set('fraudDetectionStatus', true);
        }
        if (options && options.deleteOrderId) {
            delete session.privacy.orderId;
        }
        res.redirect(URLUtilsLocal.https('Error-ErrorCode', 'err', fraudDetectionStatus.errorCode));
        return { failed: true, fraudDetectionStatus: fraudDetectionStatus };
    }
    return { failed: false, fraudDetectionStatus: fraudDetectionStatus };
}

base.runFraudDetectionAndFail = runFraudDetectionAndFail;
base.failOrderAndRedirect = failOrderAndRedirect;
base.invokeHandleHook = invokeHandleHook;
base.resolveOrderFromRequest = resolveOrderFromRequest;
base.savePaymentInstrumentToWallet = savePaymentInstrumentToWallet;
base.handlePayments = handlePayments;
base.validatePayment = validatePayment;
base.getOrderPaymentInstruments = getOrderPaymentInstruments;
base.validatePPLForm = validatePPLForm;
base.getPayPalInstrument = getPayPalInstrument;
base.handlePayPal = handlePayPal;
base.clearPaymentAttributes = clearPaymentAttributes;
base.handleSilentPostAuthorize = handleSilentPostAuthorize;
base.reCreateBasket = reCreateBasket;
base.addOrUpdateToken = addOrUpdateToken;
base.getNonGCPaymemtInstument = getNonGCPaymemtInstument;
base.calculatePaymentTransaction = calculatePaymentTransaction;
base.failOrder = failOrder;
base.reviewOrder = reviewOrder;
base.submitOrder = submitOrder;
base.submitApplePayOrder = submitApplePayOrder;
base.placeOrder = placeOrder;

module.exports = base;