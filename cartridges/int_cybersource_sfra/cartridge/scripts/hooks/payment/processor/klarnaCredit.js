'use strict';

var klarnaAdaptor = require('*/cartridge/scripts/klarna/adaptor/KlarnaAdaptor');

/**
* Current implementation simply creates a payment method and returns 'success'.
*/
 
exports.Handle = function (basket, paymentInformation, paymentMethod) {
     
    var response = klarnaAdaptor.HandleRequest(basket, true, paymentMethod);
    return response;
};

/**
 * Authorizes a payment using a Klarna.
 */
 
exports.Authorize = function (orderNumber, paymentInstrument, paymentProcessor) {
    //  Get the token from parameter map.
     
    var token = session.privacy.KlarnaPaymentsAuthorizationToken;

    //  Call method to handle the request
    var response = klarnaAdaptor.AuthorizeRequest(orderNumber, paymentInstrument, token);
    return response;
};
