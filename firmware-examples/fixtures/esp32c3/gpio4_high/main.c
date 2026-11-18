// Fixture A: GPIO4 constantly HIGH
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
static unsigned fib(unsigned n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
void app_main(void) {
    gpio_reset_pin(GPIO_NUM_4);
    gpio_set_direction(GPIO_NUM_4, GPIO_MODE_OUTPUT);
    gpio_set_level(GPIO_NUM_4, 1);
    printf("PLUGAI_FIXTURE gpio4_high fib(24)=%u\n", fib(24));
    while (1) vTaskDelay(pdMS_TO_TICKS(1000));
}
