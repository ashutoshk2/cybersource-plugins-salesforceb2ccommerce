'use strict';

module.exports = function () {
    $('body').on('product:updateAddToCart', function (e, response) {
        if (response.product.readyToOrder) {
            var applePayButton = $('.apple-pay-pdp', response.$productContainer);
            if (applePayButton.length !== 0) {
                applePayButton.attr('sku', response.product.id);
            } else {
                if ($('.apple-pay-pdp').length === 0) {  
                    $('.cart-and-ipay').append('<isapplepay class="apple-pay-pdp btn"'
                        + 'sku=' + response.product.id + '></isapplepay>');
                }
            }
        } else {
            $('.apple-pay-pdp').remove();
        }
    });
};
