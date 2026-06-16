'use strict';

 
var server = require('server');
var csrfProtection = require('*/cartridge/scripts/middleware/csrf');
var secureResponseHelper = require('*/cartridge/scripts/helpers/secureResponseHelper');
var secureJsonResponse = secureResponseHelper.secureJsonResponse;
/**
 * Controller that handles the Cybersource paypal processing, manages redirection/callback from paypal,
 *
 *
 * @module controllers/CYBPaypal
 */
var CybersourceConstants = require('*/cartridge/scripts/utils/CybersourceConstants');
var CommonHelper = require('*/cartridge/scripts/helper/CommonHelper');

server.post(
    'SessionCallback',
    server.middleware.https,
    csrfProtection.generateToken,
    function (req, res, next) {
        var collections = require('*/cartridge/scripts/util/collections');
        var URLUtils = require('dw/web/URLUtils');
        var BasketMgr = require('dw/order/BasketMgr');
        var basketCalculationHelpers = require('*/cartridge/scripts/helpers/basketCalculationHelpers');
        var cart = BasketMgr.getCurrentBasket();
        var adapter = require(CybersourceConstants.PAYPAL_ADAPTOR);
        var paymentId = request.httpParameterMap.paymentID.stringValue;
        var payerID = request.httpParameterMap.payerID.stringValue;
        var requestID = request.httpParameterMap.requestId.stringValue;
        var fundingSource = request.httpParameterMap.fundingSource.stringValue;

        // Flag to check if PayPal Credit is used
        var isPayPalCredit = request.httpParameterMap.isPayPalCredit.booleanValue;
        var billingAgreementFlag = request.httpParameterMap.billingAgreementFlag.booleanValue;

        var args = {};
        args.payerID = payerID;
        args.paymentID = paymentId;
        args.requestId = requestID;
        args.fundingSource = fundingSource;
        args.billingAgreementFlag = !!billingAgreementFlag;
        args.isPayPalCredit = !!isPayPalCredit;
        var paymentMethod;
        if (args.isPayPalCredit) {
            paymentMethod = CybersourceConstants.METHOD_PAYPAL_CREDIT;
        } else {
            paymentMethod = CybersourceConstants.METHOD_PAYPAL;
        }

        var result = {};
        var Transaction = require('dw/system/Transaction');
        // call the call back method for initSession Service/check Status service
        result = adapter.SessionCallback(cart, args);
        if (result.shippingAddressMissing) { session.privacy.paypalShippingIncomplete = true; } else { session.privacy.paypalShippingIncomplete = false; }
        if (result.billingAddressMissing) { session.privacy.paypalBillingIncomplete = true; } else { session.privacy.paypalBillingIncomplete = false; }
        Transaction.wrap(function () {
            basketCalculationHelpers.calculateTotals(cart);
        });

        var COHelpers = require('*/cartridge/scripts/checkout/checkoutHelpers');
        if (COHelpers.invokeHandleHook(paymentMethod, cart, paymentMethod, requestID, payerID, paymentId).error) {
            result.success = false;
        }
        if (result.success) {
            var paymentID = args.paymentID !== null ? args.paymentID : result.transactionProcessorID;
            payerID = args.payerID !== null ? args.payerID : result.payerID;
            requestID = args.requestId !== null ? args.requestId : result.requestID;
            var pi = CommonHelper.findPaymentInstrumentByMethod(cart, [CybersourceConstants.METHOD_PAYPAL, CybersourceConstants.METHOD_PAYPAL_CREDIT]);
            Transaction.wrap(function () {
                // set the request ID for payment instrument
                pi.paymentTransaction.custom.requestId = requestID;
                // set the payerID for payment instrument
                pi.paymentTransaction.custom.payerID = payerID;
                // Set the payment ID
                pi.paymentTransaction.custom.apSessionProcessorTID = paymentID;
                pi.paymentTransaction.custom.apPaymentType = CybersourceConstants.PAYPAL_PAYMENT_TYPE;
                if (pi.paymentMethod.equals(CybersourceConstants.METHOD_PAYPAL) && billingAgreementFlag
                     && ('billingAgreementStatus' in session.privacy && session.privacy.billingAgreementStatus != null)) {
                    pi.paymentTransaction.custom.billingAgreementStatus = session.privacy.billingAgreementStatus;
                    session.privacy.billingAgreementStatus = '';
                }
            });
        }

        if (result.success) {
            var ShippingHelper = require('*/cartridge/scripts/checkout/shippingHelpers');
            var COHelpers = require('*/cartridge/scripts/checkout/checkoutHelpers');
            Transaction.wrap(function () {
                // Update the shipping method based on the selected shipping method or selected address form PAYPAL instance.
                ShippingHelper.selectShippingMethod(cart.defaultShipment, cart.defaultShipment.shippingMethodID);
                // Calculate the basket
                basketCalculationHelpers.calculateTotals(cart);
                // Re-calculate the payments.
                COHelpers.calculatePaymentTransaction(cart);
            });
            session.forms.billing.addressFields.copyFrom(cart.getBillingAddress());
            if ('states' in session.forms.billing.addressFields) { session.forms.billing.addressFields.states.copyFrom(cart.getBillingAddress()); }
            if ('paypalShippingIncomplete' in session.privacy && session.privacy.paypalShippingIncomplete) {
                res.redirect(URLUtils.https('Checkout-Begin', 'stage', 'shipping'));
                return next();
            }
            if ('paypalBillingIncomplete' in session.privacy && session.privacy.paypalBillingIncomplete) {
                res.redirect(URLUtils.https('Checkout-Begin', 'stage', 'payment'));
                session.privacy.paypalminiCart = true;
                return next();
            }
            session.privacy.paypalminiCart = false;
            res.redirect(URLUtils.https('Checkout-Begin', 'stage', 'placeOrder'));
        } else {
            res.redirect(URLUtils.https('Cart-Show'));
        }
        return next();
    }
);

/**
 * PayPal V2 callback - Handles GET redirect from PayPal after buyer approval.
 * PayPal appends ?token=...&PayerID=... to the successURL.
 * Query params from the successURL configured in createOrderServiceV2 are also present
 * (billingAgreementFlag, isPayPalCredit, fundingSource).
 */
server.get(
    'PaypalV2Callback',
    server.middleware.https,
    csrfProtection.generateToken,
    function (req, res, next) {
        var collections = require('*/cartridge/scripts/util/collections');
        var Logger = require('dw/system/Logger').getLogger('Cybersource');
        var URLUtils = require('dw/web/URLUtils');
        var BasketMgr = require('dw/order/BasketMgr');
        var Transaction = require('dw/system/Transaction');
        var basketCalculationHelpers = require('*/cartridge/scripts/helpers/basketCalculationHelpers');
        var TaxHelper = require('*/cartridge/scripts/helper/TaxHelper');
        var adapter = require(CybersourceConstants.PAYPAL_ADAPTOR);

        var cart = BasketMgr.getCurrentBasket();
        if (!cart) {
            Logger.error('[CYBPaypal-PaypalV2Callback] No basket found');
            res.redirect(URLUtils.https('Cart-Show'));
            return next();
        }

        // PayPal-appended params
        var token = request.httpParameterMap.token.stringValue;
        var payerID = request.httpParameterMap.PayerID.stringValue;

        // Our own params from the successURL
        var billingAgreementFlag = request.httpParameterMap.billingAgreementFlag.booleanValue;
        var isPayPalCredit = request.httpParameterMap.isPayPalCredit.booleanValue;
        var fundingSource = request.httpParameterMap.fundingSource.stringValue || 'paypal';

        // requestID stored in session during InitiatePaypalV2 (Create Order response)
        var requestID = session.privacy.paypalV2RequestID;

        Logger.debug('[CYBPaypal-PaypalV2Callback] V2 callback - token: {0}, PayerID: {1}, fundingSource: {2}, requestID: {3}',
            token, payerID, fundingSource, requestID);

        if (!requestID) {
            Logger.error('[CYBPaypal-PaypalV2Callback] Missing paypalV2RequestID in session');
            res.redirect(URLUtils.https('Cart-Show'));
            return next();
        }

        // Build args compatible with adapter.SessionCallback (reuses existing check-status logic)
        var args = {};
        args.payerID = payerID;
        args.paymentID = token; // PayPal order token
        args.requestId = requestID;
        args.fundingSource = fundingSource;
        args.billingAgreementFlag = !!billingAgreementFlag;
        args.isPayPalCredit = !!isPayPalCredit;

        var paymentMethod;
        if (args.isPayPalCredit) {
            paymentMethod = CybersourceConstants.METHOD_PAYPAL_CREDIT;
        } else {
            paymentMethod = CybersourceConstants.METHOD_PAYPAL;
        }

        // V2: Call dedicated V2 callback that handles absence of address fields in Check Status response
        var result = adapter.PaypalV2Callback(cart, args);

        if (result.shippingAddressMissing) { session.privacy.paypalShippingIncomplete = true; } else { session.privacy.paypalShippingIncomplete = false; }
        if (result.billingAddressMissing) { session.privacy.paypalBillingIncomplete = true; } else { session.privacy.paypalBillingIncomplete = false; }

        TaxHelper.recalculateAndRoundV2(cart);

        // Only proceed if check-status returned ACCEPT
        if (!result.success) {
            Logger.error('[CYBPaypal-PaypalV2Callback] Check Status did not return ACCEPT - redirecting to cart');
            res.redirect(URLUtils.https('Cart-Show'));
            return next();
        }

        // Verify basket total hasn't changed since buyer approved on PayPal.
        var paypalFacade = require('*/cartridge/scripts/paypal/facade/PayPalFacade');
        var reconcileResult = paypalFacade.reconcileV2Amount(cart, { orderRequestID: requestID, fundingSource: fundingSource });
        if (reconcileResult.status === 'voided') {
            res.redirect(URLUtils.https('Cart-Show'));
            return next();
        }

        // Create / update PayPal payment instrument via hook
        var COHelpersV2 = require('*/cartridge/scripts/checkout/checkoutHelpers');
        if (COHelpersV2.invokeHandleHook(paymentMethod, cart, paymentMethod, requestID, payerID, token).error) {
            Logger.error('[CYBPaypal-PaypalV2Callback] Handle hook returned error');
            res.redirect(URLUtils.https('Cart-Show'));
            return next();
        }

        // Persist transaction data on the payment instrument
        var pi = CommonHelper.findPaymentInstrumentByMethod(cart, [CybersourceConstants.METHOD_PAYPAL, CybersourceConstants.METHOD_PAYPAL_CREDIT]);

        Transaction.wrap(function () {
            pi.paymentTransaction.custom.requestId = requestID;
            pi.paymentTransaction.custom.payerID = payerID;
            pi.paymentTransaction.custom.apSessionProcessorTID = token;
            pi.paymentTransaction.custom.apPaymentType = fundingSource === 'venmo'
                ? CybersourceConstants.VENMO_PAYMENT_TYPE
                : CybersourceConstants.PAYPAL_V2_PAYMENT_TYPE;
            // V2: Store orderRequestID so Auth/Sale can reference it
            pi.paymentTransaction.custom.orderRequestID = requestID;
            pi.paymentTransaction.custom.fundingSource = fundingSource;
            if (pi.paymentMethod.equals(CybersourceConstants.METHOD_PAYPAL) && billingAgreementFlag
                && ('billingAgreementStatus' in session.privacy && session.privacy.billingAgreementStatus != null)) {
                pi.paymentTransaction.custom.billingAgreementStatus = session.privacy.billingAgreementStatus;
                session.privacy.billingAgreementStatus = '';
            }
        });

        // Recalculate and finalize
        var ShippingHelper = require('*/cartridge/scripts/checkout/shippingHelpers');
        var COHelpers = require('*/cartridge/scripts/checkout/checkoutHelpers');
        Transaction.wrap(function () {
            ShippingHelper.selectShippingMethod(cart.defaultShipment, cart.defaultShipment.shippingMethodID);
        });
        TaxHelper.recalculateAndRoundV2(cart);
        Transaction.wrap(function () {
            COHelpers.calculatePaymentTransaction(cart);
        });

        session.forms.billing.addressFields.copyFrom(cart.getBillingAddress());
        if ('states' in session.forms.billing.addressFields) {
            session.forms.billing.addressFields.states.copyFrom(cart.getBillingAddress());
        }

        if ('paypalShippingIncomplete' in session.privacy && session.privacy.paypalShippingIncomplete) {
            res.redirect(URLUtils.https('Checkout-Begin', 'stage', 'shipping'));
            return next();
        }
        if ('paypalBillingIncomplete' in session.privacy && session.privacy.paypalBillingIncomplete) {
            res.redirect(URLUtils.https('Checkout-Begin', 'stage', 'payment'));
            session.privacy.paypalminiCart = true;
            return next();
        }

        session.privacy.paypalminiCart = false;
        res.redirect(URLUtils.https('Checkout-Begin', 'stage', 'placeOrder'));
        return next();
    }
);

/**
 *  Initiates PayPal V1 express Checkout. For V2, use InitiatePaypalV2 instead.
 */
server.post(
    'InitiatePaypalExpress',
    server.middleware.https,
    csrfProtection.generateToken,
    function (req, res, next) {
        var adapter = require(CybersourceConstants.PAYPAL_ADAPTOR);
        var Logger = require('dw/system/Logger').getLogger('Cybersource');

        var BasketMgr = require('dw/order/BasketMgr');
        var cart = BasketMgr.getCurrentBasket();
        var billingAgreementFlag = request.httpParameterMap.billingAgreement.empty ? false : request.httpParameterMap.billingAgreement.booleanValue;
        var payPalCreditFlag = request.httpParameterMap.isPayPalCredit.empty ? false : request.httpParameterMap.isPayPalCredit.booleanValue;
        var fundingSource = request.httpParameterMap.fundingSource.empty ? 'paypal' : request.httpParameterMap.fundingSource.stringValue;

        Logger.info('InitiatePaypalExpress FundingSource: {0}', fundingSource);

        var args = {};
        args.billingAgreementFlag = billingAgreementFlag;
        args.payPalCreditFlag = payPalCreditFlag;
        args.fundingSource = fundingSource;

        var result = adapter.InitiateExpressCheckout(cart, args);
        if (result.success) {
            secureJsonResponse(res, result);
        } else {
            Logger.error('[CYBPaypal-InitiatePaypalExpress] Failed to initiate PayPal checkout');
            secureJsonResponse(res, { success: false, error: true, errorMessage: 'Failed to initiate PayPal checkout' });
        }
        return next();
    }
);

/**
 * PayPal V2: Initiates PayPal V2 Create Order
 * Creates payment instrument in basket first, then calls Create Order API
 */
server.post(
    'InitiatePaypalV2',
    server.middleware.https,
    csrfProtection.generateToken,
    function (req, res, next) {
        var adapter = require(CybersourceConstants.PAYPAL_ADAPTOR);
        var Logger = require('dw/system/Logger').getLogger('Cybersource');
        var BasketMgr = require('dw/order/BasketMgr');
        var Site = require('dw/system/Site');
        var Transaction = require('dw/system/Transaction');

        try {
            var cart = BasketMgr.getCurrentBasket();
            if (!cart) {
                Logger.error('[CYBPaypal-InitiatePaypalV2] No basket found');
                secureJsonResponse(res, { success: false, error: true, errorMessage: 'No basket found' });
                return next();
            }

            // Check if V2 is enabled
            var isV2Enabled = Site.getCurrent().getCustomPreferenceValue('CsEnablePayPalV2');
            if (!isV2Enabled) {
                Logger.error('[CYBPaypal-InitiatePaypalV2] PayPal V2 is not enabled');
                secureJsonResponse(res, { success: false, error: true, errorMessage: 'PayPal V2 is not enabled' });
                return next();
            }

            var billingAgreementFlag = request.httpParameterMap.billingAgreement.empty ? false : request.httpParameterMap.billingAgreement.booleanValue;
            var payPalCreditFlag = request.httpParameterMap.isPayPalCredit.empty ? false : request.httpParameterMap.isPayPalCredit.booleanValue;
            var fundingSource = request.httpParameterMap.fundingSource.empty ? 'paypal' : request.httpParameterMap.fundingSource.stringValue;

            // Determine payment method based on credit flag
            var paymentMethod = payPalCreditFlag ? CybersourceConstants.METHOD_PAYPAL_CREDIT : CybersourceConstants.METHOD_PAYPAL;

            // Apply billing form values to basket (if billing form was submitted)
            var paymentForm = server.forms.getForm('billing');
            var CommonHelper = require('*/cartridge/scripts/helper/CommonHelper');
            CommonHelper.applyBillingFormToBasket(cart, paymentForm);

            // Remove any existing payment instruments and create PayPal payment instrument
            var paymentAmount = CommonHelper.CalculateNonGiftCertificateAmountPaypal(cart);
            CommonHelper.removeAllPaymentInstruments(cart);
            Transaction.wrap(function () {
                cart.createPaymentInstrument(paymentMethod, paymentAmount);
            });

            var args = {};
            args.billingAgreementFlag = billingAgreementFlag;
            args.payPalCreditFlag = payPalCreditFlag;
            args.fundingSource = fundingSource;

            // V2: Call adapter which routes to createOrderServiceV2
            var result = adapter.InitiateExpressCheckout(cart, args);

            if (result && result.success) {
                // Store requestID and basket total in session for use in callback
                if (result.requestID) {
                    session.privacy.paypalV2RequestID = result.requestID;
                }
                session.privacy.paypalV2OrderAmount = cart.totalGrossPrice.value;

                // V2 returns merchantURL in the result
                if (result.merchantURL) {
                    result.redirectUrl = result.merchantURL;
                } else {
                    Logger.error('[CYBPaypal-InitiatePaypalV2] No merchantURL in response. Result: {0}', JSON.stringify(result));
                }

                secureJsonResponse(res, result);
            } else {
                Logger.error('[CYBPaypal-InitiatePaypalV2] Failed to initiate PayPal V2 checkout. Result: {0}',
                    result ? JSON.stringify(result) : 'null result');
                secureJsonResponse(res, {
                    success: false,
                    error: true,
                    errorMessage: 'Failed to initiate PayPal V2 checkout. Please check your basket and try again.'
                });
            }
        } catch (e) {
            Logger.error('[CYBPaypal-InitiatePaypalV2] Exception: {0}\nStack: {1}', e.message, e.stack);
            secureJsonResponse(res, {
                success: false,
                error: true,
                errorMessage: 'An error occurred during PayPal checkout initialization. Please try again.'
            });
        }

        return next();
    }
);

/**
 * Void a CyberSource PayPal V2 order (called when user cancels PayPal popup).
 */
server.post(
    'VoidOrder',
    server.middleware.https,
    function (req, res, next) {
        var Logger = require('dw/system/Logger').getLogger('Cybersource');
        try {
            var paypalFacade = require('*/cartridge/scripts/paypal/facade/PayPalFacade');
            var result = paypalFacade.cancelV2Session();
            secureJsonResponse(res, { success: !result.error });
        } catch (e) {
            Logger.error('[CYBPaypal-VoidOrder] Exception: {0}', e.message);
            secureJsonResponse(res, { success: false });
        }
        return next();
    }
);

module.exports = server.exports();
