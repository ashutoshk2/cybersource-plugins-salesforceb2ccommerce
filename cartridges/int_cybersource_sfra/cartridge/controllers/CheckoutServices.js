'use strict';

/* eslint-disable */
var page = module.superModule;
var server = require('server');

var Site = require('dw/system/Site');
var Bytes = require('dw/util/Bytes');
var csrfProtection = require('*/cartridge/scripts/middleware/csrf');
var userLoggedIn = require('*/cartridge/scripts/middleware/userLoggedIn');
var consentTracking = require('*/cartridge/scripts/middleware/consentTracking');
var COHelpers = require('*/cartridge/scripts/checkout/checkoutHelpers');

var IsCartridgeEnabled = Site.getCurrent().getCustomPreferenceValue('IsCartridgeEnabled');
var secureResponseHelper = require('*/cartridge/scripts/helpers/secureResponseHelper');
var secureJsonResponse = secureResponseHelper.secureJsonResponse;
var secureRender = secureResponseHelper.secureRender;

server.extend(page);
/**
 * Checks if a credit card is valid or not
 * @param {Object} card - plain object with card details
 * @param {Object} form - form object
 * @returns {boolean} a boolean representing card validation
 */

/**
 * PayPal custom address validation handling. Function validates all the billing address fields with email and phone number.
 */
server.post('ValidatePayPalBillingAddress', csrfProtection.validateRequest, server.middleware.https, function (req, res, next) {
    var billingFormErrors = {};
    var pplFormErrors = {};
    var paymentForm = server.forms.getForm('billing');
    billingFormErrors = COHelpers.validateBillingForm(paymentForm.addressFields);

    var pplPhoneandEmailForm = new Object();
    pplPhoneandEmailForm.email = server.forms.getForm('billing').paypalBillingFields.paypalEmail;
    pplPhoneandEmailForm.phone = server.forms.getForm('billing').paypalBillingFields.paypalPhone;
    pplFormErrors = COHelpers.validatePPLForm(pplPhoneandEmailForm);

    var Transaction = require('dw/system/Transaction');
    var BasketMgr = require('dw/order/BasketMgr');
    var CommonHelper = require('*/cartridge/scripts/helper/CommonHelper');
    var currentBasket = BasketMgr.getCurrentBasket();
    var defaultShipment = currentBasket.getDefaultShipment();
    var shippingAddress = defaultShipment.getShippingAddress();

    CommonHelper.applyBillingFormToBasket(currentBasket, paymentForm);

    Transaction.wrap(function () {
        var billingAddress = currentBasket.billingAddress;
        if (!empty(paymentForm.paypalBillingFields.paypalEmail.value)) {
            currentBasket.setCustomerEmail(paymentForm.paypalBillingFields.paypalEmail.value);
        }
        if (!empty(paymentForm.paypalBillingFields.paypalPhone.value)) {
            billingAddress.setPhone(paymentForm.paypalBillingFields.paypalPhone.value);
            if (!empty(shippingAddress)) { shippingAddress.setPhone(paymentForm.paypalBillingFields.paypalPhone.value); }
        }
    });

    if (Object.keys(billingFormErrors).length || Object.keys(pplFormErrors).length) {
        // respond with form data and errors - use secure response helper
        secureJsonResponse(res, {
            form: paymentForm,
            fieldErrors: [billingFormErrors, pplFormErrors],
            serverErrors: [],
            error: true
        });
    } else {
        session.privacy.paypalBillingIncomplete = false;
        // Copy over billing address to shipping for Paypal billing agreement

        secureJsonResponse(res, {
            form: paymentForm,
            fieldErrors: [],
            serverErrors: [],
            error: false
        });
    }
    return next();
});

if (IsCartridgeEnabled) {
    server.prepend('SubmitPayment', server.middleware.https, csrfProtection.validateAjaxRequest, function (req, res, next) {
        var Resource = require('dw/web/Resource');
        var paymentForm = server.forms.getForm('billing');
        var paymentMethodID = paymentForm.paymentMethod.value;

        if (empty(session.forms.billing.creditCardFields.securityCode.value)) {
            session.forms.billing.creditCardFields.securityCode.value = request.httpParameterMap.securityCode.value;
        }

        if (paymentMethodID == Resource.msg('paymentmethodname.paypal', 'cybersource', null)) {
            handlePayPal(req, res, next);
            this.emit('route:Complete', req, res);
            return;
        }

        // Void any active PayPal V2 order when customer switches to a different payment method
        // This releases the authorization hold on their PayPal account and frees merchant order capacity
        if (session.privacy.paypalV2RequestID) {
            var paypalFacade = require('*/cartridge/scripts/paypal/facade/PayPalFacade');
            paypalFacade.cancelV2Session({ skipVoid: !Site.getCurrent().getCustomPreferenceValue('CsEnablePayPalV2') });
        }

        return next();
    });

}

server.post('SilentPostAuthorize', server.middleware.https, function (req, res, next) {

    var payerauthArgs = {};
    if (request.httpParameterMap.browserfields.submitted) {
        var browserfields = request.httpParameterMap.browserfields.value;
        if (browserfields) {
            var parsedBrowserfields = JSON.parse(browserfields);
            payerauthArgs.parsedBrowserfields = parsedBrowserfields;
        }
    }
    var URLUtils = require('dw/web/URLUtils');
    var OrderMgr = require('dw/order/OrderMgr');
    var Resource = require('dw/web/Resource');
    var Transaction = require('dw/system/Transaction');
    var Logger = require('dw/system/Logger');
    var resolved = COHelpers.resolveOrderFromRequest(req);
    var order = resolved.order;
    var orderID = resolved.orderID;

    if (!order) {
        Logger.error('[CheckoutServices-SilentPostAuthorize] Order ownership validation failed for orderID: ' + (orderID || 'null'));
        res.redirect(URLUtils.https('Checkout-Begin', 'stage', 'payment', 'payerAuthError', Resource.msg('error.technical', 'checkout', null)));
        return next();
    }

    var isPayerAuthSetupCompleted = false;
    if (req.querystring.PayerAuthSetupCompleted) {
        isPayerAuthSetupCompleted = req.querystring.PayerAuthSetupCompleted === 'true';
    }
    payerauthArgs.isPayerAuthSetupCompleted = isPayerAuthSetupCompleted;
    var silentPostResponse = COHelpers.handleSilentPostAuthorize(order, payerauthArgs);

    if (silentPostResponse.sca) {
        secureRender(res, 'payerauthentication/3dsRedirect', {
            action: URLUtils.url('CheckoutServices-PayerAuthSetup'),
            OrderNo: order.orderNo,
            OrderToken: order.orderToken,
        });
        return next();
    }
    if (silentPostResponse.error || silentPostResponse.declined || silentPostResponse.rejected) {
        Transaction.wrap(function () {
            OrderMgr.failOrder(order, true);
        });
        delete session.privacy.orderId;
    }
    if (silentPostResponse.error) {
        delete session.privacy.orderId;
        res.redirect(URLUtils.https('Checkout-Begin', 'stage', 'payment', 'payerAuthError', Resource.msg('payerauthentication.carderror', 'cybersource', null)).toString());
    } else if (silentPostResponse.declined) {
        session.privacy.SkipTaxCalculation = false;
        res.redirect(URLUtils.https('Checkout-Begin', 'stage', 'placeOrder', 'placeOrderError', Resource.msg('sa.billing.payment.error.declined', 'cybersource', null)));
        return next();
    } else if (silentPostResponse.rejected) {
        res.redirect(URLUtils.https('Checkout-Begin', 'stage', 'payment', 'payerAuthError', Resource.msg('payerauthentication.carderror', 'cybersource', null)).toString());
        return next();
    } else if (silentPostResponse.authorized || silentPostResponse.review || silentPostResponse.process3DRedirection) {
        var customerObj = (!empty(customer) && customer.authenticated) ? customer : null;
        COHelpers.addOrUpdateToken(order, customerObj, res);
        if (silentPostResponse.process3DRedirection) {
            res.redirect(URLUtils.https('CheckoutServices-PayerAuthentication', 'accessToken', silentPostResponse.jwt));
            return next();
        }
        session.privacy.orderId = order.orderNo;

        if (silentPostResponse.review) {
            res.redirect(URLUtils.https('COPlaceOrder-SilentPostReviewOrder'));
            return next();
        }

        res.redirect(URLUtils.https('COPlaceOrder-SilentPostSubmitOrder'));
        return next();
    } else {
        res.redirect(URLUtils.https('Checkout-Begin', 'stage', 'payment', 'SecureAcceptanceError', 'true'));
        return next();
    }
    return next();
});

if (IsCartridgeEnabled) {
    server.prepend('PlaceOrder', server.middleware.https, function (req, res, next) {
        // POST-only middleware check
        if (req.httpMethod !== 'POST') {
            res.setStatusCode(405);
            secureJsonResponse(res, {
                error: true,
                errorMessage: 'POST method required'
            });
            return next();
        }
        var BasketMgr = require('dw/order/BasketMgr');
        var OrderMgr = require('dw/order/OrderMgr');
        var URLUtils = require('dw/web/URLUtils');

        var currentBasket = BasketMgr.getCurrentBasket();
        if (!currentBasket) {
            if ('isPaymentRedirectInvoked' in session.privacy && session.privacy.isPaymentRedirectInvoked !== null
                && 'orderId' in session.privacy && session.privacy.orderId !== null) {
                var order = OrderMgr.getOrder(session.privacy.orderId);
                var currentBasket = COHelpers.reCreateBasket(order);
                secureJsonResponse(res, {
                    error: true,
                    cartError: true,
                    fieldErrors: [],
                    serverErrors: [],
                    redirectUrl: URLUtils.url('Cart-Show').toString()
                });
            }
        }

        // PayPal V2: Verify basket total still matches the approved amount.
        if (currentBasket && session.privacy.paypalV2OrderAmount !== null
            && session.privacy.paypalV2OrderAmount !== undefined) {
            var TaxHelper = require('*/cartridge/scripts/helper/TaxHelper');
            TaxHelper.recalculateAndRoundV2(currentBasket);
            if (Site.getCurrent().getCustomPreferenceValue('CsEnablePayPalV2') && session.privacy.paypalV2RequestID) {
                var paypalFacadeReconcile = require('*/cartridge/scripts/paypal/facade/PayPalFacade');
                var reconcile = paypalFacadeReconcile.reconcileV2Amount(currentBasket);
                if (reconcile.status === 'voided') {
                    var Resource = require('dw/web/Resource');
                    secureJsonResponse(res, {
                        error: true,
                        errorStage: { stage: 'payment' },
                        errorMessage: Resource.msg('paypal.amount.mismatch', 'cybersource', 'Your cart has changed since PayPal approval. Please select a payment method again.')
                    });
                    this.emit('route:Complete', req, res);
                    return;
                }
            }
        }

        return next();
    });

    server.append('PlaceOrder', server.middleware.https, function (req, res, next) {

        var klarnaHelper = require('*/cartridge/scripts/klarna/helper/KlarnaHelper');
        var paypalFacade = require('*/cartridge/scripts/paypal/facade/PayPalFacade');
        session.privacy.paypalShippingIncomplete = '';
        session.privacy.paypalBillingIncomplete = '';
        paypalFacade.cancelV2Session({ skipVoid: true });

        //  Reset decision session variable
        var CommonHelperReset = require('*/cartridge/scripts/helper/CommonHelper');
        CommonHelperReset.resetCheckoutSessionVars({ resetFraudDecision: true });
        klarnaHelper.clearKlarnaSessionVariables();

        return next();
    });
}

server.get('PayerAuthentication', server.middleware.https, function (req, res, next) {
    var AcsURL = session.privacy.AcsURL;
    var PAReq = session.privacy.PAReq;
    var PAXID = session.privacy.PAXID;
    var stepUpUrl = session.privacy.stepUpUrl;
    var jwtToken = req.querystring.accessToken;
    session.privacy.AcsURL = '';
    session.privacy.PAReq = '';
    res.setContentType('application/json;charset=utf-8');
    secureRender(res, 'cart/cardinalPayerAuthentication', {
        AcsURL: AcsURL,
        PAReq: PAReq,
        PAXID: PAXID,
        authenticationTransactionID: session.privacy.authenticationTransactionID,
        jwtToken: jwtToken,
        stepUpUrl: stepUpUrl,
    });
    return next();
});

/* Route to handle paypal submission. This route is called only when either
    PayPal Express or PayPal billing agreement is called from either mini cart or cart page. */
 
function handlePayPal(req, res, next) {
    var billingFormErrors = {};
    var viewData = {};
    var Transaction = require('dw/system/Transaction');
    var BasketMgr = require('dw/order/BasketMgr');
    var paymentForm = server.forms.getForm('billing');

    var pplFormErrors = {};
    var pplPhoneandEmailForm = {};
    pplPhoneandEmailForm.email = server.forms.getForm('billing').paypalBillingFields.paypalEmail;
    pplPhoneandEmailForm.phone = server.forms.getForm('billing').paypalBillingFields.paypalPhone;
    pplFormErrors = COHelpers.validatePPLForm(pplPhoneandEmailForm);
    billingFormErrors = COHelpers.validateBillingForm(paymentForm.addressFields);

    if (Object.keys(billingFormErrors).length || Object.keys(pplFormErrors).length) {
        // respond with form data and errors
        secureJsonResponse(res, {
            form: paymentForm,
            fieldErrors: [billingFormErrors, pplFormErrors],
            serverErrors: [],
            error: true
        });
    } else {
        var currentBasket = BasketMgr.getCurrentBasket();
        var billingAddress = currentBasket.billingAddress;
        var billingForm = server.forms.getForm('billing');
        viewData.address = {
            firstName: { value: paymentForm.addressFields.firstName.value },
            lastName: { value: paymentForm.addressFields.lastName.value },
            address1: { value: paymentForm.addressFields.address1.value },
            address2: { value: paymentForm.addressFields.address2.value },
            city: { value: paymentForm.addressFields.city.value },
            postalCode: { value: paymentForm.addressFields.postalCode.value },
            countryCode: { value: paymentForm.addressFields.country.value }
        };
        if (Object.prototype.hasOwnProperty.call(paymentForm.addressFields, 'states')) {
            viewData.address.stateCode = { value: paymentForm.addressFields.states.stateCode.value };
        }
        viewData.email = {
            value: paymentForm.paypalBillingFields.paypalEmail.value
        };
        viewData.phone = {
            value: paymentForm.paypalBillingFields.paypalPhone.value
        };
        res.setViewData(viewData);
        Transaction.wrap(function () {
            if (!billingAddress) {
                billingAddress = currentBasket.createBillingAddress();
            }
            var billingData = res.getViewData();
            billingAddress.setFirstName(billingData.address.firstName.value);
            billingAddress.setLastName(billingData.address.lastName.value);
            billingAddress.setAddress1(billingData.address.address1.value);
            billingAddress.setAddress2(billingData.address.address2.value);
            billingAddress.setCity(billingData.address.city.value);
            billingAddress.setPostalCode(billingData.address.postalCode.value);
            if (Object.prototype.hasOwnProperty.call(billingData.address, 'stateCode')) {
                billingAddress.setStateCode(billingData.address.stateCode.value);
            }
            billingAddress.setCountryCode(billingData.address.countryCode.value);
            billingAddress.setPhone(billingData.phone.value);
            currentBasket.setCustomerEmail(billingData.email.value);
        });
        var Locale = require('dw/util/Locale');
        var OrderModel = require('*/cartridge/models/order');
        var AccountModel = require('*/cartridge/models/account');
        var usingMultiShipping = req.session.privacyCache.get('usingMultiShipping');
        if (usingMultiShipping === true && currentBasket.shipments.length < 2) {
            req.session.privacyCache.set('usingMultiShipping', false);
            usingMultiShipping = false;
        }
        var currentLocale = Locale.getLocale(req.locale.id);
        var basketModel = new OrderModel(currentBasket, { usingMultiShipping: usingMultiShipping, countryCode: currentLocale.country, containerView: 'basket' });
        var accountModel = new AccountModel(req.currentCustomer);
        var renderedStoredPaymentInstrument = COHelpers.getRenderedPaymentInstruments(
            req,
            accountModel
        );
        secureJsonResponse(res, {
            renderedPaymentInstruments: renderedStoredPaymentInstrument,
            customer: accountModel,
            order: basketModel,
            form: billingForm,
            error: false
        });
    }
}

/**
 * Update shipping details in cart object
 */
 
function shippingUpdate(cart, shippingdetails) {
    var shipment = cart.defaultShipment;
    if (!empty(shipment.getShippingAddress())) {
        return { success: true };
    }
    try {
        var mobileAdaptor = require('*/cartridge/scripts/mobilepayments/adapter/MobilePaymentsAdapter');
        mobileAdaptor.UpdateShipping(shippingdetails);
        return { success: true };
    } catch (err) {
        var logger = require('dw/system/Logger');
        logger.error('Error creating shipment from Google pay address: {0}', err.message);
        return { error: true, errorMsg: err.message };
    }
}

/**
 * GooglePay Checkout returned error back to merchant site, further return user back to user journey starting page, either cart or billing page
 */
function googlePayCheckoutError(req, res, next) {
    var CybersourceConstants = require('*/cartridge/scripts/utils/CybersourceConstants');
    var CommonHelper = require(CybersourceConstants.CS_CORE_SCRIPT + 'helper/CommonHelper');
    CommonHelper.renderExpressCheckoutError(req, res, {
        paymentMethodID: CybersourceConstants.METHOD_GooglePay,
        statusName: 'GoogleCheckoutError'
    });
    return next();
}


server.post('GetGooglePayToken', csrfProtection.validateRequest, function (req, res, next) {
    var Encoding = require('dw/crypto/Encoding');
    var repsonse = JSON.parse(request.httpParameterMap.paymentData);
    // Extract authentication details from Google Pay response

    var BasketMgr = require('dw/order/BasketMgr');
    var cart = BasketMgr.getCurrentBasket();
    var shippingdetails = repsonse.shippingAddress;// add condition for only cart
    var mobileAdaptor = require('*/cartridge/scripts/mobilepayments/adapter/MobilePaymentsAdapter');
    var logger = require('dw/system/Logger');
    var cardInfo = repsonse.paymentMethodData.info;
    var Transaction = require('dw/system/Transaction');
    var isAuthenticated = false;
    var result = mobileAdaptor.UpdateBilling(cart, cardInfo, repsonse.email);
    // Check if assuranceDetails exists and get authentication status
    if (cardInfo && cardInfo.assuranceDetails) {
        isAuthenticated = cardInfo.assuranceDetails.cardHolderAuthenticated;
    }
    // call the call back method for initSession Service/check Status service
    // only if shipping from cart
    if (result.success) {
        result = shippingUpdate(cart, shippingdetails);
        if (result.success) {
            cart = BasketMgr.getCurrentBasket();
            // calculate cart and redirect to summary page
            COHelpers.recalculateBasket(cart);
            var GPtoken = repsonse.paymentMethodData.tokenizationData.token;
            var CommonHelperGP = require('*/cartridge/scripts/helper/CommonHelper');
            CommonHelperGP.applyGooglePayTokenToBasket(cart, GPtoken, isAuthenticated);
        } else {
            logger.error('Error in google Checkout payment: problem in billing details');
            googlePayCheckoutError(req, res, next);
        }

        if (request.httpParameterMap.paymentData != null) {
            secureJsonResponse(res, {
                status: 'success'
            });
            return next();
        }
    } else {
        logger.error('Error in google Checkout payment: problem in billing details');
        googlePayCheckoutError(req, res, next);
    }
});

//checkout Gpay
server.post('SubmitPaymentGP', csrfProtection.validateRequest, function (req, res, next) {
    var Encoding = require('dw/crypto/Encoding');
    var paymentForm = server.forms.getForm('billing');
    var paymentMethodID = server.forms.getForm('billing').paymentMethod.value;
    var Transaction = require('dw/system/Transaction');
    var billingFormErrors = {};
    var viewData = {};
    var BasketMgr = require('dw/order/BasketMgr');
    var currentBasket = BasketMgr.getCurrentBasket();
    var paymentData = JSON.parse(request.httpParameterMap.googletoken);
    var cardInfo = paymentData.paymentMethodData.info;
    var Resource = require('dw/web/Resource');

    var isAuthenticated = false;
    if (cardInfo && cardInfo.assuranceDetails) {
        isAuthenticated = cardInfo.assuranceDetails.cardHolderAuthenticated;
    }
    var GPtoken = paymentData.paymentMethodData.tokenizationData.token;



    billingFormErrors = COHelpers.validateBillingForm(paymentForm.addressFields);

    if (Object.keys(billingFormErrors).length) {
        // respond with form data and errors
        secureJsonResponse(res, {
            form: paymentForm,
            fieldErrors: [billingFormErrors],
            serverErrors: [],
            error: true
        });
    } else {
        viewData.address = {
            firstName: { value: paymentForm.addressFields.firstName.value },
            lastName: { value: paymentForm.addressFields.lastName.value },
            address1: { value: paymentForm.addressFields.address1.value },
            address2: { value: paymentForm.addressFields.address2.value },
            city: { value: paymentForm.addressFields.city.value },
            postalCode: { value: paymentForm.addressFields.postalCode.value },
            countryCode: { value: paymentForm.addressFields.country.value }
        };

        if (Object.prototype.hasOwnProperty
            .call(paymentForm.addressFields, 'states')) {
            viewData.address.stateCode = { value: paymentForm.addressFields.states.stateCode.value };
        }

        viewData.paymentMethod = {
            value: paymentForm.paymentMethod.value,
            htmlName: paymentForm.paymentMethod.value
        };

        viewData.email = {
            value: paymentForm.creditCardFields.email.value
        };

        viewData.phone = { value: paymentForm.creditCardFields.phone.value };

        viewData.saveCard = paymentForm.creditCardFields.saveCard.checked;

        res.setViewData(viewData);

        this.on('route:BeforeComplete', function (req, res) {  

            var URLUtils = require('dw/web/URLUtils');
            var basketCalculationHelpers = require('*/cartridge/scripts/helpers/basketCalculationHelpers');
            var billingData = res.getViewData();

            if (!currentBasket) {
                delete billingData.paymentInformation;

                secureJsonResponse(res, {
                    error: true,
                    cartError: true,
                    fieldErrors: [],
                    serverErrors: [],
                    redirectUrl: URLUtils.url('Cart-Show').toString()
                });
                return;
            }

            var billingAddress = currentBasket.billingAddress;
            var billingForm = server.forms.getForm('billing');
            paymentMethodID = billingData.paymentMethod.value;
            var result;

            billingForm.creditCardFields.cardNumber.htmlValue = '';
            billingForm.creditCardFields.securityCode.htmlValue = '';

            Transaction.wrap(function () {
                if (!billingAddress) {
                    billingAddress = currentBasket.createBillingAddress();
                }

                billingAddress.setFirstName(billingData.address.firstName.value);
                billingAddress.setLastName(billingData.address.lastName.value);
                billingAddress.setAddress1(billingData.address.address1.value);
                billingAddress.setAddress2(billingData.address.address2.value);
                billingAddress.setCity(billingData.address.city.value);
                billingAddress.setPostalCode(billingData.address.postalCode.value);
                if (Object.prototype.hasOwnProperty.call(billingData.address, 'stateCode')) {
                    billingAddress.setStateCode(billingData.address.stateCode.value);
                }
                billingAddress.setCountryCode(billingData.address.countryCode.value);

                if (billingData.storedPaymentUUID) {
                    billingAddress.setPhone(req.currentCustomer.profile.phone);
                    currentBasket.setCustomerEmail(req.currentCustomer.profile.email);
                } else {
                    billingAddress.setPhone(billingData.phone.value);
                    currentBasket.setCustomerEmail(billingData.email.value);
                }
            });

            //    Add hook to call google payment
            var mobileAdaptor = require('*/cartridge/scripts/mobilepayments/adapter/MobilePaymentsAdapter');
            result = mobileAdaptor.UpdateBilling(currentBasket, cardInfo, paymentData.email);

            var CommonHelperGP2 = require('*/cartridge/scripts/helper/CommonHelper');
            CommonHelperGP2.applyGooglePayTokenToBasket(currentBasket, GPtoken, isAuthenticated);
            // Calculate the basket
            Transaction.wrap(function () {
                basketCalculationHelpers.calculateTotals(currentBasket);
            });

            // Re-calculate the payments.
            var calculatedPaymentTransaction = COHelpers.calculatePaymentTransaction(currentBasket);

            if (calculatedPaymentTransaction.error) {
                secureJsonResponse(res, {
                    form: paymentForm,
                    fieldErrors: [],
                    serverErrors: [Resource.msg('error.technical', 'checkout', null)],
                    error: true
                });
                return;
            }

            // return back google
            if (result.success) {
                if (request.httpParameterMap.paymentData != null) {
                    secureJsonResponse(res, {
                        error: false
                    });
                }
            }
        });
    }
    return next();
});


// Returns the current basket total as a plain numeric string for Google Pay
server.get('GetCartTotal', function (req, res, next) {
    var BasketMgr = require('dw/order/BasketMgr');
    var cart = BasketMgr.getCurrentBasket();

    if (!cart) {
        secureResponseHelper.secureJsonResponse(res, {
            error: true,
            totalPrice: '0'
        });
        return next();
    }

    var totalGrossPrice = cart.totalGrossPrice;
    var currencyCode = totalGrossPrice.available
        ? totalGrossPrice.currencyCode
        : session.getCurrency().getCurrencyCode();

    var totalPrice = totalGrossPrice.available
        ? totalGrossPrice.value.toFixed(2)
        : 'NA';

    secureResponseHelper.secureJsonResponse(res, {
        error: false,
        totalPrice: totalPrice,
        currencyCode: currencyCode
    });

    return next();
});


if (IsCartridgeEnabled) {
    var ALLOWED_RENDER_TEMPLATES = [
        'secureacceptance/secureAcceptanceIframeSummmary',
        'secureacceptance/secureAcceptanceSilentPost',
        'services/secureAcceptanceRequestForm',
        'alipay/alipayIntermediate',
        'checkout/confirmation/weChatConfirmation'
    ];

    // New route to handle template rendering for some payment methods.
    server.post('ProcessingPayment', server.middleware.https, function (req, res, next) {
        var Logger = require('dw/system/Logger');
        var CommonHelper = require('*/cartridge/scripts/helper/CommonHelper');

        // Get template data from POST parameters
        var renderTemplate = req.form.renderTemplate;
        var templateDataString = req.form.templateData;
        var isIframe = req.form.iframe === 'true';

        if (!renderTemplate || ALLOWED_RENDER_TEMPLATES.indexOf(renderTemplate) === -1) {
            Logger.error('Blocked disallowed or missing renderTemplate: ' + renderTemplate);
            secureJsonResponse(res, { error: true });
            return next();
        }

        if (renderTemplate) {
            var templateData = {};
            if (templateDataString) {
                try {
                    templateData = JSON.parse(templateDataString);
                    if (templateData.requestData) {
                        templateData.requestData = CommonHelper.JSONObjectToHashMap(templateData.requestData);
                    }
                } catch (parseError) {
                    Logger.error('Error parsing templateData JSON: ' + String(parseError));
                    Logger.error('Raw templateDataString: ' + templateDataString);
                }
            }

            // Handle SA-iframe case - render template and return HTML content
            if (isIframe) {
                var OrderMgr = require('dw/order/OrderMgr');
                var order = OrderMgr.getOrder(req.form.orderID || req.form.OrderNo, req.form.orderToken);
                if (!order) {
                    Logger.error('Order not found or token mismatch for orderID: ' + (req.form.orderID || req.form.OrderNo));
                    secureJsonResponse(res, { error: true });
                    return next();
                }
                templateData.Order = order;
                secureRender(res, renderTemplate, templateData);
                return next();
            }

            // Regular case - render the template
            secureRender(res, renderTemplate, templateData);
            return next();
        } else {
            Logger.error('No renderTemplate parameter found in POST data');
        }
    });
}

// Route to perform the payer auth setup and device data collection.
server.post('PayerAuthSetup', csrfProtection.generateToken, function (req, res, next) {

    var Resource = require('dw/web/Resource');
    var URLUtils = require('dw/web/URLUtils');
    var CybersourceConstants = require('*/cartridge/scripts/utils/CybersourceConstants');
    var CardFacade = require('*/cartridge/scripts/facade/CardFacade');
    var VisaCheckoutFacade = require('*/cartridge/scripts/visacheckout/facade/VisaCheckoutFacade');
    var Transaction = require('dw/system/Transaction');
    var OrderMgr = require('dw/order/OrderMgr');

    var Logger = require('dw/system/Logger');
    var resolved = COHelpers.resolveOrderFromRequest(req);
    var order = resolved.order;
    var orderID = resolved.orderID;

    if (!orderID) {
        Logger.error('[CheckoutServices-PayerAuthSetup] Missing orderID');
        res.redirect(URLUtils.https('Checkout-Begin', 'stage', 'payment', 'payerAuthError', Resource.msg('error.technical', 'checkout', null)));
        return next();
    }

    if (!order) {
        Logger.error('[CheckoutServices-PayerAuthSetup] Order ownership validation failed for orderID: ' + orderID);
        res.redirect(URLUtils.https('Checkout-Begin', 'stage', 'payment', 'payerAuthError', Resource.msg('error.technical', 'checkout', null)));
        return next();
    }

    var paymentInstrument = null;
    if (!empty(order.getPaymentInstruments())) {
        paymentInstrument = order.getPaymentInstruments()[0];
    }
    var action;
    var CsSAType = Site.getCurrent().getCustomPreferenceValue('CsSAType').value;

    if (paymentInstrument.paymentMethod === Resource.msg('paymentmethodname.creditcard', 'cybersource', null) && CsSAType == Resource.msg('cssatype.SA_SILENTPOST', 'cybersource', null)) {
        action = URLUtils.url('CheckoutServices-SilentPostAuthorize', "PayerAuthSetupCompleted", 'true');
    }
    else {
        action = URLUtils.url('CheckoutServices-PayerAuthSubmit', "PayerAuthSetupCompleted", 'true');
    }

    var paymentMethodID = paymentInstrument.paymentMethod;
    var paymentForm = server.forms.getForm('billing');
    var result;
    if (paymentMethodID.equals(CybersourceConstants.METHOD_VISA_CHECKOUT)) {
        result = VisaCheckoutFacade.PayerAuthSetup(order.orderNo);
    } else {
        result = CardFacade.PayerAuthSetup(paymentInstrument, order.orderNo, paymentForm.creditCardFields);
    }
    Transaction.wrap(function () {
        paymentInstrument.custom.PayerAuthSetupReferenceID = result.referenceID;
    });
    if (result.deviceDataCollectionURL == null) {
        res.redirect(URLUtils.url('Checkout-Begin', 'stage', 'payment', 'payerAuthError', Resource.msg('error.technical', 'checkout', null)));
        return next();
    }
    res.setContentType('application/json');
    secureRender(res, 'payerauthentication/deviceDataCollection', {
        jwtToken: result.accessToken,
        referenceID: result.referenceID,
        orderNo: order.orderNo,
        orderToken: order.orderToken,
        ddcUrl: result.deviceDataCollectionURL,
        action: action
    });
    return next();
});

server.post('PayerAuthSubmit', csrfProtection.generateToken, function (req, res, next) {
    var Resource = require('dw/web/Resource');
    var Transaction = require('dw/system/Transaction');
    var URLUtils = require('dw/web/URLUtils');
    var addressHelpers = require('*/cartridge/scripts/helpers/addressHelpers');
    var OrderMgr = require('dw/order/OrderMgr');
    var payerauthArgs = {};

    // Handle browser fields if submitted
    if (request.httpParameterMap.browserfields.submitted) {
        var browserfields = request.httpParameterMap.browserfields.value;
        if (browserfields) {
            var parsedBrowserfields = JSON.parse(browserfields);
            payerauthArgs.parsedBrowserfields = parsedBrowserfields;
        }
    }

    var Logger = require('dw/system/Logger');
    var resolved = COHelpers.resolveOrderFromRequest(req);
    var order = resolved.order;
    var orderID = resolved.orderID;

    if (!order) {
        Logger.error('[CheckoutServices-PayerAuthSubmit] Order ownership validation failed for orderID: ' + (orderID || 'null'));
        res.redirect(URLUtils.https('Checkout-Begin', 'stage', 'payment', 'payerAuthError', Resource.msg('error.technical', 'checkout', null)));
        return next();
    }

    var isPayerAuthSetupCompleted = false;
    if (req.querystring.PayerAuthSetupCompleted) {
        isPayerAuthSetupCompleted = req.querystring.PayerAuthSetupCompleted === 'true';
    }
    payerauthArgs.isPayerAuthSetupCompleted = isPayerAuthSetupCompleted;
    // Handles payment authorization
    var handlePaymentResult = COHelpers.handlePayments(order, order.orderNo, payerauthArgs);


    // Handle different payment result scenarios
    if (handlePaymentResult.error) {
        COHelpers.failOrderAndRedirect(order, res, { stage: 'payment', errorParam: 'payerAuthError', msgKey: 'error.technical', msgBundle: 'checkout' });
        return next();
    }

    if (handlePaymentResult.declined) {
        COHelpers.failOrderAndRedirect(order, res, { stage: 'placeOrder', errorParam: 'placeOrderError', msgKey: 'sa.billing.payment.error.declined', msgBundle: 'cybersource', resetSkipTax: true });
        return next();
    }

    if (handlePaymentResult.rejected) {
        COHelpers.failOrderAndRedirect(order, res, { stage: 'payment', errorParam: 'payerAuthError', msgKey: 'payerauthentication.carderror', msgBundle: 'cybersource' });
        return next();
    }
    if (handlePaymentResult.sca) {
        secureRender(res, 'payerauthentication/3dsRedirect', {
            action: URLUtils.url('CheckoutServices-PayerAuthSetup'),
            OrderNo: order.orderNo,
            OrderToken: order.orderToken,
        });
        return next();
    }

    // Handle 3D Redirection
    if (handlePaymentResult.process3DRedirection) {
        res.redirect(URLUtils.url('CheckoutServices-PayerAuthentication', 'accessToken', handlePaymentResult.jwt));
        return next();
    }

    // Handle authorized or review status
    if (handlePaymentResult.authorized || handlePaymentResult.review) {
        var BasketMgr = require('dw/order/BasketMgr');
        var currentBasket = BasketMgr.getCurrentBasket();

        // Run fraud detection
        var fraudResult = COHelpers.runFraudDetectionAndFail(currentBasket, order, req, res, { deleteOrderId: true });
        if (fraudResult.failed) {
            return next();
        }
        var fraudDetectionStatus = fraudResult.fraudDetectionStatus;

        if (handlePaymentResult.authorized) {
            // Place the order
            var placeOrderResult = COHelpers.placeOrder(order, fraudDetectionStatus);
            if (placeOrderResult.error) {
                COHelpers.failOrderAndRedirect(order, res, { stage: 'placeOrder', errorParam: 'placeOrderError', msgKey: 'error.technical', msgBundle: 'checkout' });
                return next();
            }
        }

        // Save addresses to customer address book if logged in
        if (req.currentCustomer && req.currentCustomer.addressBook) {
            var allAddresses = addressHelpers.gatherShippingAddresses(order);
            allAddresses.forEach(function (address) {
                if (!addressHelpers.checkIfAddressStored(address, req.currentCustomer.addressBook.addresses)) {
                    addressHelpers.saveAddress(address, req.currentCustomer, addressHelpers.generateAddressName(address));
                }
            });
        }
        //  Set order confirmation status to not confirmed for REVIEW orders.
        if (session.privacy.CybersourceFraudDecision === 'REVIEW') {
            var Order = require('dw/order/Order');
            Transaction.wrap(function () {
                order.setConfirmationStatus(Order.CONFIRMATION_STATUS_NOTCONFIRMED);
            });
        }
        // Send confirmation email
        if (order.getCustomerEmail()) {
            COHelpers.sendConfirmationEmail(order, req.locale.id);
        }

        // Clean up session
        delete session.privacy.orderId;
        req.session.privacyCache.set('usingMultiShipping', false);

        // Redirect to order confirmation
        res.redirect(URLUtils.url('COPlaceOrder-SubmitOrderConformation', 'ID', order.orderNo, 'token', order.orderToken).toString());
        return next();
    }

    // Default case - unexpected result
    COHelpers.failOrderAndRedirect(order, res, { stage: 'payment', errorParam: 'payerAuthError', msgKey: 'error.technical', msgBundle: 'checkout' });
    return next();
});

module.exports = server.exports();
