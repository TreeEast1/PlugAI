// Fixture: deliberate compile error (undeclared identifier + missing semicolon)
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
void app_main(void) {
    gpio_reset_pin(GPIO_NUM_4);
    gpio_set_direction(GPIO_NUM_4, GPIO_MODE_OUTPUT)
    while (1) { gpio_set_level(GPIO_NUM_4, levle); vTaskDelay(pdMS_TO_TICKS(500)); }
}
