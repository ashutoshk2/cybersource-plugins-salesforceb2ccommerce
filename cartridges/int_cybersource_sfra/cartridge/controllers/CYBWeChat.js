'use strict';

 
var server = require('server');
var HookMgr = require('dw/system/HookMgr');
var URLUtils = require('dw/web/URLUtils');
var Resource = require('dw/web/Resource');
var OrderMgr = require('dw/order/OrderMgr');
var Order = require('dw/order/Order');
var Transaction = require('dw/system/Transaction');
var CybersourceConstants = require('*/cartridge/scripts/utils/CybersourceConstants');
var COHelpers = require('*/cartridge/scripts/checkout/checkoutHelpers');
var WeChatAdaptor = require('*/cartridge/scripts/wechat/adapter/WeChatAdaptor');
var CommonHelper = require('*/cartridge/scripts/helper/CommonHelper');
var csrfProtection = require('*/cartridge/scripts/middleware/csrf');
var secureResponseHelper = require('*/cartridge/scripts/helpers/secureResponseHelper');
var secureJsonResponse = secureResponseHelper.secureJsonResponse;

server.post('WeChatStatus', csrfProtection.validateAjaxRequest, function (req, res, next) {
    var Logger = require('dw/system/Logger');
    var orderNo = request.httpParameterMap.orderNo.stringValue;
    var orderToken = request.httpParameterMap.orderToken.stringValue;
    var order = null;
    if (orderNo) {
        if (orderToken) {
            order = OrderMgr.getOrder(orderNo, orderToken);
        } else if (session.privacy.orderId && session.privacy.orderId === orderNo) {
            order = OrderMgr.getOrder(orderNo);
        }
    }

    if (!order) {
        Logger.error('[CYBWeChat-WeChatStatus] Order ownership validation failed for orderNo: ' + (orderNo || 'null'));
        secureJsonResponse(res, {
            submit: false,
            error: true,
            pending: false,
            redirectUrl: URLUtils.https('Checkout-Begin', 'stage', 'payment', 'payerAuthError', Resource.msg('error.technical', 'checkout', null)).toString()
        });
        return next();
    }
    var pi = CommonHelper.findPaymentInstrumentByMethod(order, CybersourceConstants.WECHAT_PAYMENT_METHOD);
    var result = WeChatAdaptor.CheckStatusServiceRequest(orderNo, pi);
    var fraudDetectionStatus = HookMgr.callHook('app.fraud.detection', 'fraudDetection', order);
    var redirectUrl = '';

    if (fraudDetectionStatus && fraudDetectionStatus.status === 'fail' && result.submit) {
        Transaction.wrap(function () { OrderMgr.failOrder(order, true); });
        if (req.session && req.session.privacyCache) {
            req.session.privacyCache.set('fraudDetectionStatus', true);
        }
        secureJsonResponse(res, {
            placedOrder: null,
            submit: false,
            error: true,
            pending: false,
            redirectUrl: URLUtils.https('Error-ErrorCode', 'err', fraudDetectionStatus.errorCode).toString()
        });
        return next();
    }

    if (result.submit) {
        // place order
        Transaction.wrap(function () {
            order.setPaymentStatus(Order.PAYMENT_STATUS_PAID);
            pi.paymentTransaction.custom.AmountPaid = Number(order.totalGrossPrice);
        });

        session.privacy.paypalShippingIncomplete = '';
        session.privacy.paypalBillingIncomplete = '';
        COHelpers.sendConfirmationEmail(order, req.locale.id);
        //  Reset decision session variable
        CommonHelper.resetCheckoutSessionVars({ resetFraudDecision: true });
        // Reset usingMultiShip after successful Order placement
        req.session.privacyCache.set('usingMultiShipping', false);
        redirectUrl = URLUtils.url('COPlaceOrder-SubmitOrderConformation', 'ID', order.orderNo, 'token', order.orderToken).toString();
    } else if (result.pending) {
        session.privacy.isReCreateBasket = true;
        session.privacy.orderId = order.orderNo;
        redirectUrl = URLUtils.https('Checkout-Begin', 'stage', 'payment', 'payerAuthError', Resource.msg('wechat.pending', 'cybersource', null)).toString();
    } else {
        session.privacy.isReCreateBasket = true;
        session.privacy.orderId = order.orderNo;
        redirectUrl = URLUtils.https('Checkout-Begin', 'stage', 'payment', 'payerAuthError', Resource.msg('wechat.error', 'cybersource', null)).toString();
    }
    secureJsonResponse(res, {
        placedOrder: order,
        submit: result.submit,
        error: result.error,
        pending: result.pending,
        redirectUrl: redirectUrl
    });
    return next();
});

/*
 * Module exports
 */
module.exports = server.exports();
